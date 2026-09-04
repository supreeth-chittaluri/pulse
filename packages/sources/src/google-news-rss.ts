import type { RawPost } from '@pulse/core';
import type { Source } from './types.ts';
import { fetchText } from './http.ts';
import { htmlToText, parseFeed } from './feed.ts';

export type GoogleNewsRssOptions = {
  id: string;
  query: string;
  pollSeconds: number;
  userAgent: string;
};

/**
 * Google News RSS, one feed per search query. Free, no auth, and gives us
 * headline-level coverage for a specific ticker to contrast against the
 * retail chatter on Reddit.
 */
export function createGoogleNewsRssSource(options: GoogleNewsRssOptions): Source {
  const { id, query, pollSeconds, userAgent } = options;
  const url =
    `https://news.google.com/rss/search?q=${encodeURIComponent(query)}` +
    '&hl=en-US&gl=US&ceid=US:en';

  return {
    id,
    adapter: 'google-news-rss',
    pollSeconds,
    rateLimitBucket: null,
    async fetch(): Promise<RawPost[]> {
      const xml = await fetchText(url, { userAgent });
      return parseFeed(xml).map((entry): RawPost => ({
        source: id,
        sourcePostId: entry.id ?? entry.link ?? entry.title,
        title: entry.title,
        // Google News descriptions are a link blob, not prose. Keep whatever
        // text survives stripping; M2 mostly scores the headline here.
        body: htmlToText(entry.contentHtml, 500),
        url: entry.link ?? url,
        author: null,
        postedAt: entry.publishedAt,
      }));
    },
  };
}
