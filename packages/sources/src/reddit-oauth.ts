import type { RawPost } from '@pulse/core';
import type { Source } from './types.ts';
import { fetchJson, fetchText } from './http.ts';

export type RedditOAuthOptions = {
  id: string;
  subreddit: string;
  listing: 'new' | 'hot' | 'rising' | 'top';
  limit: number;
  pollSeconds: number;
  userAgent: string;
  clientId: string;
  clientSecret: string;
};

type TokenResponse = { access_token: string; expires_in: number };

type ListingResponse = {
  data: {
    children: Array<{
      data: {
        name: string;
        title: string;
        selftext: string;
        permalink: string;
        author: string;
        created_utc: number;
        score: number;
        num_comments: number;
      };
    }>;
  };
};

/**
 * Application-only OAuth (client_credentials), which is enough for reading
 * public listings -- no user login required.
 *
 * DORMANT BY DEFAULT. The registry only builds this adapter when both
 * REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET are set. Reddit closed self-service
 * app registration in late 2025, so until an approval lands this file is
 * unexercised -- treat its first real run as unverified.
 *
 * What it buys over RSS: up to 100 posts per call, real scores and comment
 * counts, and a 100 QPM budget instead of ~1 request/minute per feed.
 */
export function createRedditOAuthSource(options: RedditOAuthOptions): Source {
  const { id, subreddit, listing, limit, pollSeconds, userAgent, clientId, clientSecret } = options;

  let token: string | undefined;
  let tokenExpiresAt = 0;

  async function accessToken(): Promise<string> {
    if (token && Date.now() < tokenExpiresAt) return token;

    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const body = await fetchText('https://www.reddit.com/api/v1/access_token', {
      userAgent,
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
    }).catch((err: unknown) => {
      throw new Error(`Reddit token request failed: ${(err as Error).message}`, { cause: err });
    });

    const parsed = JSON.parse(body) as TokenResponse;
    token = parsed.access_token;
    // Refresh a minute early so a long fetch never straddles expiry.
    tokenExpiresAt = Date.now() + (parsed.expires_in - 60) * 1000;
    return token;
  }

  return {
    id,
    adapter: 'reddit-oauth',
    pollSeconds,
    rateLimitBucket: 'reddit',
    async fetch(): Promise<RawPost[]> {
      const bearer = await accessToken();
      const url = `https://oauth.reddit.com/r/${subreddit}/${listing}?limit=${Math.min(limit, 100)}&raw_json=1`;
      const json = await fetchJson<ListingResponse>(url, {
        userAgent,
        headers: { authorization: `Bearer ${bearer}` },
      });

      return json.data.children.map(({ data }): RawPost => ({
        source: id,
        // Same fullname the RSS adapter emits, so the two are interchangeable
        // against the posts_source_post_unique constraint.
        sourcePostId: data.name,
        title: data.title,
        body: data.selftext?.trim() ? data.selftext : null,
        url: `https://www.reddit.com${data.permalink}`,
        author: data.author,
        postedAt: new Date(data.created_utc * 1000),
      }));
    },
  };
}
