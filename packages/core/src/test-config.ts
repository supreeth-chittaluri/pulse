import type { Config } from './config.ts';

/**
 * A complete Config for tests. Lives here so that adding a field to Config
 * updates every test fixture at once instead of breaking each one in turn.
 */
export function makeTestConfig(overrides: Partial<Config> = {}): Config {
  return {
    databaseUrl: 'postgres://pulse:pulse@localhost:5433/pulse_test',
    port: 3000,
    nodeEnv: 'test',
    userAgent: 'pulse-test/0.1',
    redditOAuthEnabled: false,
    reddit: {},
    gemini: {
      model: 'gemini-3.5-flash-lite',
      minIntervalMs: 0,
      dailyRequestBudget: 400,
    },
    scoring: {
      batchSize: 15,
      autoEnabled: true,
      autoIntervalMinutes: 30,
      autoPostLimit: 60,
      triageBatchSize: 2_000,
    },
    runWorkerInApi: false,
    alerts: {
      enabled: false,
      configured: false,
      twilio: {},
      kind: 'volume+sentiment',
      cooldownHours: 6,
      dailyBudget: 10,
      maxSpikeAgeHours: 6,
    },
    auth: { jwtSecret: 'test-secret-that-is-at-least-32-characters', jwtTtlHours: 12 },
    http: {
      corsOrigins: [],
      rateLimitPerMinute: 60,
      adminRateLimitPerMinute: 10,
      cacheTtlSeconds: 20,
      trustProxy: 0,
    },
    ...overrides,
  };
}
