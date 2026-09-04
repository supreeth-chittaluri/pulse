import type { RawPost } from '@pulse/core';
import type { Source } from './types.ts';
import { fetchText } from './http.ts';
import { htmlToText, parseFeed } from './feed.ts';

export type RedditRssOptions = {
  id: string;
  subreddit: string;
  listing: 'new' | 'hot' | 'rising' | 'top';
  limit: number;
  pollSeconds: number;
  userAgent: string;
};

/**
 * Reddit's public .rss endpoints need no credentials and survived the 2023 and
 * 2025 API lockdowns. The tradeoffs versus OAuth: roughly the latest 25 posts
 * per feed, no comments, no score/upvote counts, and Reddit rate-limits a
 * single feed to about one fetch per minute -- so poll no faster than every
 * few minutes.
 */
export function createRedditRssSource(options: RedditRssOptions): Source {
  const { id, subreddit, listing, limit, pollSeconds, userAgent } = options;
  const url = `https://www.reddit.com/r/${subreddit}/${listing}/.rss?limit=${limit}`;

  return {
    id,
    adapter: 'reddit-rss',
    pollSeconds,
    rateLimitBucket: 'reddit',
    async fetch(): Promise<RawPost[]> {
      // Reddit's limiter is per-client across all feeds and is measured in
      // requests per minute, so short retries are useless here: 8s, 16s, 32s.
      const xml = await fetchText(url, { userAgent, retries: 3, retryBaseMs: 8_000 });
      return parseFeed(xml).map((entry): RawPost => ({
        source: id,
        // Reddit Atom ids are the fullname, e.g. "t3_1abc234". Stable forever,
        // and identical to what the OAuth adapter reports -- so switching
        // adapters later does not re-ingest everything as new posts.
        sourcePostId: entry.id ?? entry.link ?? entry.title,
        title: entry.title,
        body: htmlToText(entry.contentHtml),
        url: entry.link ?? url,
        author: entry.author?.replace(/^\/u\//, '') ?? null,
        postedAt: entry.publishedAt,
      }));
    },
  };
}
