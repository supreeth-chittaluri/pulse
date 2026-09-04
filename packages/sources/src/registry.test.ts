import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { Config } from '@pulse/core';
import { buildSources, loadSourceConfig, type SourceConfig } from './registry.ts';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    databaseUrl: 'postgres://localhost:5433/test',
    port: 3000,
    nodeEnv: 'test',
    userAgent: 'pulse-test/0.1',
    redditOAuthEnabled: false,
    reddit: {},
    gemini: { model: 'gemini-3.5-flash', minIntervalMs: 6_000, dailyRequestBudget: 200 },
    scoring: { batchSize: 15 },
    ...overrides,
  };
}

const REDDIT: SourceConfig[] = [
  {
    kind: 'reddit',
    id: 'reddit:test',
    subreddit: 'test',
    listing: 'new',
    limit: 50,
    pollSeconds: 300,
    enabled: true,
  },
];

describe('buildSources', () => {
  // This is the guarantee the whole source abstraction exists to provide:
  // Reddit approving our OAuth app must be a .env change, never a code change.
  it('uses the RSS adapter when Reddit credentials are absent', () => {
    const [source] = buildSources(makeConfig(), REDDIT);
    expect(source?.adapter).toBe('reddit-rss');
  });

  it('uses the OAuth adapter when Reddit credentials are present', () => {
    const config = makeConfig({
      redditOAuthEnabled: true,
      reddit: { clientId: 'id', clientSecret: 'secret' },
    });
    const [source] = buildSources(config, REDDIT);
    expect(source?.adapter).toBe('reddit-oauth');
  });

  it('keeps the same source id across both adapters, so M1 does not re-ingest', () => {
    const rss = buildSources(makeConfig(), REDDIT)[0];
    const oauth = buildSources(
      makeConfig({ redditOAuthEnabled: true, reddit: { clientId: 'a', clientSecret: 'b' } }),
      REDDIT,
    )[0];
    expect(rss?.id).toBe(oauth?.id);
  });

  it('skips disabled sources', () => {
    const disabled = REDDIT.map((s) => ({ ...s, enabled: false }));
    expect(buildSources(makeConfig(), disabled)).toHaveLength(0);
  });

  it('reports a missing config file clearly', () => {
    expect(() => loadSourceConfig('config/does-not-exist.json')).toThrow(/Could not read/);
  });
});

describe('loadSourceConfig', () => {
  it('rejects duplicate source ids', () => {
    const path = `${tmpdir()}/pulse-dup-${process.pid}.json`;
    writeFileSync(path, JSON.stringify({ sources: [REDDIT[0], { ...REDDIT[0] }] }));
    try {
      expect(() => loadSourceConfig(path)).toThrow(/Duplicate source id/);
    } finally {
      rmSync(path, { force: true });
    }
  });

  it('rejects a poll interval below the 60s floor', () => {
    const path = `${tmpdir()}/pulse-fast-${process.pid}.json`;
    writeFileSync(path, JSON.stringify({ sources: [{ ...REDDIT[0], pollSeconds: 5 }] }));
    try {
      expect(() => loadSourceConfig(path)).toThrow(/Invalid source config/);
    } finally {
      rmSync(path, { force: true });
    }
  });
});

describe('config/sources.json', () => {
  it('is valid and builds every configured source', () => {
    const entries = loadSourceConfig();
    expect(entries.length).toBeGreaterThan(0);
    const sources = buildSources(makeConfig(), entries);
    expect(sources.length).toBe(entries.filter((e) => e.enabled).length);
    // Ids are written to posts.source and are half the M1 dedupe key.
    expect(new Set(sources.map((s) => s.id)).size).toBe(sources.length);
  });

  it('never polls a Reddit feed faster than its rate limiter allows', () => {
    for (const entry of loadSourceConfig()) {
      if (entry.kind === 'reddit') expect(entry.pollSeconds).toBeGreaterThanOrEqual(300);
    }
  });
});
