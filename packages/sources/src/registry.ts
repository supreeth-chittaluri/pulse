import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import type { Config } from '@pulse/core';
import type { Source } from './types.ts';
import { createRedditRssSource } from './reddit-rss.ts';
import { createRedditOAuthSource } from './reddit-oauth.ts';
import { createHnRssSource } from './hn-rss.ts';
import { createGoogleNewsRssSource } from './google-news-rss.ts';

const listingSchema = z.enum(['new', 'hot', 'rising', 'top']).default('new');

const sourceConfigSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('reddit'),
    id: z.string().min(1),
    subreddit: z.string().min(1),
    listing: listingSchema,
    limit: z.number().int().positive().max(100).default(50),
    pollSeconds: z.number().int().min(60).default(300),
    enabled: z.boolean().default(true),
  }),
  z.object({
    kind: z.literal('hn-rss'),
    id: z.string().min(1),
    url: z.url(),
    pollSeconds: z.number().int().min(60).default(600),
    enabled: z.boolean().default(true),
  }),
  z.object({
    kind: z.literal('google-news-rss'),
    id: z.string().min(1),
    query: z.string().min(1),
    pollSeconds: z.number().int().min(60).default(900),
    enabled: z.boolean().default(true),
  }),
]);

const fileSchema = z.object({ sources: z.array(sourceConfigSchema).min(1) });

export type SourceConfig = z.infer<typeof sourceConfigSchema>;

const DEFAULT_CONFIG_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../config/sources.json',
);

export function loadSourceConfig(path: string = DEFAULT_CONFIG_PATH): SourceConfig[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Could not read source config at ${path}: ${(err as Error).message}`, {
      cause: err,
    });
  }

  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  sources${i.path.length ? `.${i.path.join('.')}` : ''}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid source config at ${path}:\n${issues}`);
  }

  const ids = new Set<string>();
  for (const source of parsed.data.sources) {
    if (ids.has(source.id)) throw new Error(`Duplicate source id in config: ${source.id}`);
    ids.add(source.id);
  }
  return parsed.data.sources;
}

/**
 * Turns config entries into live Source objects.
 *
 * The Reddit branch is the point of the whole abstraction: identical config
 * produces the RSS adapter today and the OAuth adapter the moment Reddit
 * approves the app and the two credentials land in .env. No milestone is
 * blocked on that approval.
 */
export function buildSources(config: Config, entries?: SourceConfig[]): Source[] {
  const list = (entries ?? loadSourceConfig()).filter((entry) => entry.enabled);

  return list.map((entry): Source => {
    switch (entry.kind) {
      case 'reddit': {
        const shared = {
          id: entry.id,
          subreddit: entry.subreddit,
          listing: entry.listing,
          limit: entry.limit,
          pollSeconds: entry.pollSeconds,
          userAgent: config.userAgent,
        };
        if (config.redditOAuthEnabled) {
          return createRedditOAuthSource({
            ...shared,
            clientId: config.reddit.clientId!,
            clientSecret: config.reddit.clientSecret!,
          });
        }
        return createRedditRssSource(shared);
      }
      case 'hn-rss':
        return createHnRssSource({ ...entry, userAgent: config.userAgent });
      case 'google-news-rss':
        return createGoogleNewsRssSource({ ...entry, userAgent: config.userAgent });
    }
  });
}
