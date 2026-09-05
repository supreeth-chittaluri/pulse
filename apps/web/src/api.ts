/** Typed client for the pulse API. Mirrors the server's response shapes. */

export type Role = 'demo' | 'admin';

export type Signal = {
  id: number;
  postId: number;
  source: string;
  tickerOrTopic: string;
  sentimentScore: number;
  confidence: number | null;
  rawExcerpt: string;
  scrapedAt: string;
  title: string;
  url: string;
};

export type Spike = {
  tickerOrTopic: string;
  detectedAt: string;
  mentionCount: number;
  volumeZ: number;
  sentimentZ: number | null;
  currentSentiment: number | null;
  baselineAvgVolume: number;
  kind: 'volume' | 'volume+sentiment';
};

export type TickerSummary = {
  tickerOrTopic: string;
  mentions: number;
  avgSentiment: number;
  lastSeenAt: string;
  baselineAvgSentiment: number | null;
  baselineAvgVolume: number | null;
};

export type TrendPoint = { bucket: string; mentions: number; avgSentiment: number };

export type Stats = {
  posts: number;
  signals: number;
  tickers: number;
  spikes: number;
  lastIngestAt: string | null;
  lastSignalAt: string | null;
};

export type WatchlistEntry = {
  tickerOrTopic: string;
  alertThreshold: number;
  smsTo: string | null;
  lastAlertedAt: string | null;
};

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'ApiError';
  }
}

/**
 * The token lives in memory only, never localStorage.
 *
 * A token in localStorage is readable by any script that gets injected into the
 * page. Losing the session on refresh is a small cost, and the demo account is
 * read-only anyway.
 */
let token: string | null = null;

export function setToken(value: string | null): void {
  token = value;
}

export function getToken(): string | null {
  return token;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (init.body) headers.set('content-type', 'application/json');

  const response = await fetch(path, { ...init, headers });
  const text = await response.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* non-JSON error page */
  }

  if (!response.ok) {
    throw new ApiError(response.status, body?.message ?? body?.error ?? response.statusText);
  }
  return body as T;
}

export const api = {
  stats: () => request<Stats>('/api/stats'),
  signals: (limit = 40) => request<{ signals: Signal[] }>(`/api/signals?limit=${limit}`),
  /** Cursor-based read for the polling transport; oldest-first after `afterId`. */
  signalsAfter: (afterId: number, limit = 50) =>
    request<{ signals: Signal[]; cursor: number }>(
      `/api/signals?afterId=${afterId}&limit=${limit}`,
    ),
  spikes: (limit = 10) => request<{ spikes: Spike[] }>(`/api/spikes?limit=${limit}`),
  tickers: (limit = 25) => request<{ tickers: TickerSummary[] }>(`/api/tickers?limit=${limit}`),
  ticker: (ticker: string, hours = 168) =>
    request<{ ticker: string; trend: TrendPoint[]; signals: Signal[] }>(
      `/api/tickers/${encodeURIComponent(ticker)}?hours=${hours}`,
    ),

  login: (email: string, password: string) =>
    request<{ token: string; role: Role; email: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  signup: (email: string, password: string) =>
    request<never>('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  watchlist: () => request<{ watchlist: WatchlistEntry[] }>('/api/admin/watchlist'),
  addWatch: (tickerOrTopic: string, alertThreshold: number) =>
    request<unknown>('/api/admin/watchlist', {
      method: 'POST',
      body: JSON.stringify({ tickerOrTopic, alertThreshold }),
    }),
  removeWatch: (ticker: string) =>
    request<unknown>(`/api/admin/watchlist/${encodeURIComponent(ticker)}`, { method: 'DELETE' }),
};

/** Bearish (-1) through neutral (0) to bullish (+1). */
export type Polarity = 'bearish' | 'neutral' | 'bullish';

/** Anything inside this band reads as neutral, matching M3's spike deadband. */
export const NEUTRAL_BAND = 0.2;

export function polarity(score: number): Polarity {
  if (score > NEUTRAL_BAND) return 'bullish';
  if (score < -NEUTRAL_BAND) return 'bearish';
  return 'neutral';
}

/**
 * Colour for a sentiment value, as a CSS variable reference.
 *
 * Hue never carries the meaning alone -- every place this is used also prints
 * the signed number, which is what makes the encoding safe for colour-blind
 * readers and in print.
 */
export function sentimentColor(score: number): string {
  const p = polarity(score);
  if (p === 'bullish') return 'var(--bullish)';
  if (p === 'bearish') return 'var(--bearish)';
  return 'var(--ink-muted)';
}

export function formatScore(score: number): string {
  return `${score > 0 ? '+' : score < 0 ? '−' : ''}${Math.abs(score).toFixed(2)}`;
}

export function timeAgo(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${Math.floor(seconds)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
