import { XMLParser } from 'fast-xml-parser';

/**
 * Normalized feed entry. Reddit serves Atom, Hacker News and Google News serve
 * RSS 2.0, so we flatten both shapes into one thing the adapters can map.
 */
export type FeedEntry = {
  id: string | null;
  title: string;
  link: string | null;
  publishedAt: Date | null;
  contentHtml: string | null;
  author: string | null;
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  // Titles like "AMD &amp; NVDA" must come back as "AMD & NVDA".
  processEntities: true,
  htmlEntities: true,
});

/** XML nodes are string | number | { '#text': ... } depending on content. */
function text(node: unknown): string | null {
  if (node === null || node === undefined) return null;
  if (typeof node === 'string') return node.trim() || null;
  if (typeof node === 'number' || typeof node === 'boolean') return String(node);
  if (typeof node === 'object' && '#text' in node) {
    return text((node as Record<string, unknown>)['#text']);
  }
  return null;
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function parseFeed(xml: string): FeedEntry[] {
  const doc = parser.parse(xml) as Record<string, any>;

  if (doc.feed) {
    return asArray(doc.feed.entry).map((entry: any): FeedEntry => {
      const link = asArray(entry.link).find((l: any) => l?.['@_href']);
      return {
        id: text(entry.id),
        title: text(entry.title) ?? '(untitled)',
        link: link?.['@_href'] ?? null,
        publishedAt: parseDate(text(entry.published) ?? text(entry.updated)),
        contentHtml: text(entry.content) ?? text(entry.summary),
        author: text(entry.author?.name),
      };
    });
  }

  if (doc.rss?.channel) {
    return asArray(doc.rss.channel.item).map((item: any): FeedEntry => ({
      id: text(item.guid) ?? text(item.link),
      title: text(item.title) ?? '(untitled)',
      link: text(item.link),
      publishedAt: parseDate(text(item.pubDate)),
      contentHtml: text(item.description) ?? text(item['content:encoded']),
      author: text(item['dc:creator']) ?? text(item.author),
    }));
  }

  throw new Error('Unrecognized feed format: expected an Atom <feed> or RSS <rss><channel>');
}

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
};

/**
 * Reddit double-encodes its Atom <content>, so entities survive one decode by
 * the XML parser and arrive here as literal "&#32;" / "&amp;" text. Decode
 * repeatedly (bounded) until it stops changing.
 */
function decodeEntities(input: string): string {
  let current = input;
  for (let pass = 0; pass < 3; pass += 1) {
    const next = current.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
      const key = entity.toLowerCase();
      if (key.startsWith('#x')) {
        const code = Number.parseInt(key.slice(2), 16);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      if (key.startsWith('#')) {
        const code = Number.parseInt(key.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      return NAMED_ENTITIES[key] ?? match;
    });
    if (next === current) break;
    current = next;
  }
  return current;
}

/**
 * Feed bodies are HTML. Claude scores plain text in M2 and raw_excerpt is
 * shown in the UI in M6, so strip tags once here rather than in three places.
 */
export function htmlToText(html: string | null, maxLength = 2000): string | null {
  if (!html) return null;
  // Strip tags before decoding entities, so text that was legitimately escaped
  // in the source (a code snippet containing "&lt;div&gt;") survives instead of
  // turning into a tag and being deleted.
  const stripped = decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6])>/gi, '\n\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t\u00a0]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!stripped) return null;
  return stripped.length > maxLength ? `${stripped.slice(0, maxLength)}...` : stripped;
}
