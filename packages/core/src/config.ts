import { randomBytes } from 'node:crypto';
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
  GEMINI_MODEL: z.string().default('gemini-3.5-flash-lite'),
  GEMINI_MIN_INTERVAL_MS: z.coerce.number().int().min(0).default(4_000),
  GEMINI_DAILY_REQUEST_BUDGET: z.coerce.number().int().positive().default(400),
  SCORING_BATCH_SIZE: z.coerce.number().int().min(1).max(50).default(15),

  // M4.
  JWT_SECRET: z.string().optional(),
  JWT_TTL_HOURS: z.coerce.number().int().positive().default(12),
  CORS_ORIGINS: z.string().default(''),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(60),
  ADMIN_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(10),
  CACHE_TTL_SECONDS: z.coerce.number().int().min(0).default(20),
  // Render/Fly/Vercel put a proxy in front of us. Without this every request
  // appears to come from the proxy and one client throttles everyone.
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),

  // M7. COSTS MONEY -- alerting stays off until ALERTS_ENABLED is true.
  ALERTS_ENABLED: z
    .string()
    .default('false')
    .transform((value) => value === 'true'),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM_NUMBER: z.string().optional(),
  TWILIO_TO_NUMBER: z.string().optional(),
  ALERT_KIND: z.enum(['volume+sentiment', 'any']).default('volume+sentiment'),
  ALERT_COOLDOWN_HOURS: z.coerce.number().int().min(0).default(6),
  ALERT_DAILY_BUDGET: z.coerce.number().int().min(0).default(10),
  ALERT_MAX_SPIKE_AGE_HOURS: z.coerce.number().int().min(1).default(6),

  // M8. Free hosting tiers generally bill background workers but not web
  // services, so a $0 deployment runs ingestion inside the API process.
  RUN_WORKER_IN_API: z
    .string()
    .default('false')
    .transform((value) => value === 'true'),
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
  auth: { jwtSecret: string; jwtTtlHours: number };
  alerts: {
    enabled: boolean;
    configured: boolean;
    twilio: { accountSid?: string; authToken?: string; from?: string; to?: string };
    kind: 'volume+sentiment' | 'any';
    cooldownHours: number;
    dailyBudget: number;
    maxSpikeAgeHours: number;
  };
  runWorkerInApi: boolean;
  http: {
    corsOrigins: string[];
    rateLimitPerMinute: number;
    adminRateLimitPerMinute: number;
    cacheTtlSeconds: number;
    trustProxy: number;
  };
};

/**
 * A predictable signing key is a complete auth bypass, so production refuses to
 * start without one. Development gets a random per-process key instead: tokens
 * stop working across restarts, which is mildly annoying and much safer than a
 * checked-in default that reaches production by accident.
 */
function resolveJwtSecret(secret: string | undefined, nodeEnv: string): string {
  if (secret && secret.length >= 32) return secret;
  if (nodeEnv === 'production') {
    throw new Error(
      'JWT_SECRET must be set to at least 32 characters in production.\n' +
        'Generate one with:  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"',
    );
  }
  if (secret) {
    throw new Error(`JWT_SECRET is set but only ${secret.length} chars; needs at least 32.`);
  }
  return randomBytes(48).toString('base64url');
}

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
    auth: { jwtSecret: resolveJwtSecret(env.JWT_SECRET, env.NODE_ENV), jwtTtlHours: env.JWT_TTL_HOURS },
    alerts: {
      enabled: env.ALERTS_ENABLED,
      configured: Boolean(
        env.TWILIO_ACCOUNT_SID &&
          env.TWILIO_AUTH_TOKEN &&
          env.TWILIO_FROM_NUMBER &&
          env.TWILIO_TO_NUMBER,
      ),
      twilio: {
        accountSid: env.TWILIO_ACCOUNT_SID,
        authToken: env.TWILIO_AUTH_TOKEN,
        from: env.TWILIO_FROM_NUMBER,
        to: env.TWILIO_TO_NUMBER,
      },
      kind: env.ALERT_KIND,
      cooldownHours: env.ALERT_COOLDOWN_HOURS,
      dailyBudget: env.ALERT_DAILY_BUDGET,
      maxSpikeAgeHours: env.ALERT_MAX_SPIKE_AGE_HOURS,
    },
    runWorkerInApi: env.RUN_WORKER_IN_API,
    http: {
      corsOrigins: env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean),
      rateLimitPerMinute: env.RATE_LIMIT_PER_MINUTE,
      adminRateLimitPerMinute: env.ADMIN_RATE_LIMIT_PER_MINUTE,
      cacheTtlSeconds: env.CACHE_TTL_SECONDS,
      trustProxy: env.TRUST_PROXY,
    },
  };
  return cached;
}

/** Test-only escape hatch. */
export function resetConfigCache(): void {
  cached = undefined;
}
