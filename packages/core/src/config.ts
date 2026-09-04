import { z } from 'zod';

/**
 * Environment schema. Anything a milestone hasn't reached yet is optional, so
 * M0 runs with almost everything blank -- but the moment a key IS set it gets
 * validated, which is how the Reddit adapter switch below stays honest.
 */
const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required (see .env.example)'),
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  USER_AGENT: z.string().min(1).default('pulse/0.1 (personal project)'),

  // Reddit OAuth is all-or-nothing: both halves, or neither.
  REDDIT_CLIENT_ID: z.string().optional(),
  REDDIT_CLIENT_SECRET: z.string().optional(),

  // M2+, unused in M0/M1.
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default('gemini-3.5-flash'),
  GEMINI_MIN_INTERVAL_MS: z.coerce.number().int().min(0).default(6_000),
  GEMINI_DAILY_REQUEST_BUDGET: z.coerce.number().int().positive().default(200),
  SCORING_BATCH_SIZE: z.coerce.number().int().min(1).max(50).default(15),
});

export type Config = {
  databaseUrl: string;
  port: number;
  nodeEnv: 'development' | 'test' | 'production';
  userAgent: string;
  /** True only when BOTH Reddit OAuth credentials are present. */
  redditOAuthEnabled: boolean;
  reddit: { clientId?: string; clientSecret?: string };
  gemini: {
    apiKey?: string;
    model: string;
    minIntervalMs: number;
    dailyRequestBudget: number;
  };
  scoring: { batchSize: number };
};

let cached: Config | undefined;

/** Loads .env (if present) and validates process.env. Cached after first call. */
export function loadConfig(): Config {
  if (cached) return cached;

  try {
    process.loadEnvFile();
  } catch {
    // No .env on disk -- fine in CI and in production, where the platform
    // injects real environment variables.
  }

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment:\n${issues}\n\nSee .env.example.`);
  }

  const env = parsed.data;
  const hasId = Boolean(env.REDDIT_CLIENT_ID);
  const hasSecret = Boolean(env.REDDIT_CLIENT_SECRET);
  if (hasId !== hasSecret) {
    throw new Error(
      'Set both REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET, or neither. ' +
        'With neither, the public .rss adapter is used instead.',
    );
  }

  cached = {
    databaseUrl: env.DATABASE_URL,
    port: env.PORT,
    nodeEnv: env.NODE_ENV,
    userAgent: env.USER_AGENT,
    redditOAuthEnabled: hasId && hasSecret,
    reddit: { clientId: env.REDDIT_CLIENT_ID, clientSecret: env.REDDIT_CLIENT_SECRET },
    gemini: {
      apiKey: env.GEMINI_API_KEY,
      model: env.GEMINI_MODEL,
      minIntervalMs: env.GEMINI_MIN_INTERVAL_MS,
      dailyRequestBudget: env.GEMINI_DAILY_REQUEST_BUDGET,
    },
    scoring: { batchSize: env.SCORING_BATCH_SIZE },
  };
  return cached;
}

/** Test-only escape hatch. */
export function resetConfigCache(): void {
  cached = undefined;
}
