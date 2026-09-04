import type { RawPost } from '@pulse/core';
import type { Source } from './types.ts';
import { fetchText } from './http.ts';
import { htmlToText, parseFeed } from './feed.ts';

export type HnRssOptions = {
  id: string;
  url: string;
  pollSeconds: number;
  userAgent: string;
};

/**
 * Hacker News via hnrss.org. No auth, no meaningful rate limit, and it hedges
 * the Reddit dependency: if Reddit ever blocks us outright, ingestion keeps
 * running and the demo keeps working.
 */
export function createHnRssSource(options: HnRssOptions): Source {
  const { id, url, pollSeconds, userAgent } = options;

  return {
    id,
    adapter: 'hn-rss',
    pollSeconds,
    rateLimitBucket: null,
    async fetch(): Promise<RawPost[]> {
      const xml = await fetchText(url, { userAgent });
      return parseFeed(xml).map((entry): RawPost => ({
        source: id,
        // hnrss guids are the HN item permalink -- stable per story.
        sourcePostId: entry.id ?? entry.link ?? entry.title,
        title: entry.title,
        body: htmlToText(entry.contentHtml),
        url: entry.link ?? url,
        author: entry.author,
        postedAt: entry.publishedAt,
      }));
    },
  };
}
