/**
 * Shared fetch wrapper: identifies us honestly, times out, and retries on the
 * transient failures that actually happen when polling public feeds (429 from
 * Reddit's aggressive RSS limiter, 5xx, connection resets).
 */
export type HttpOptions = {
  userAgent: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
  /** First backoff step; doubles each attempt. Raise it for stingy limiters. */
  retryBaseMs?: number;
};

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, url: string, body: string) {
    super(`HTTP ${status} for ${url}: ${body.slice(0, 200)}`);
    this.name = 'HttpError';
    this.status = status;
  }
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

export async function fetchText(url: string, options: HttpOptions): Promise<string> {
  const {
    userAgent,
    headers = {},
    timeoutMs = 15_000,
    retries = 3,
    retryBaseMs = 1_000,
  } = options;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) {
      // Doubling backoff. Reddit's limiter is per-client and budgets roughly
      // one request per minute across ALL feeds, so its adapter passes a much
      // larger retryBaseMs than the default.
      await new Promise((r) => setTimeout(r, retryBaseMs * 2 ** (attempt - 1)));
    }
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': userAgent, accept: 'application/xml, text/xml, */*', ...headers },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        const error = new HttpError(response.status, url, body);
        if (RETRYABLE.has(response.status) && attempt < retries) {
          lastError = error;
          continue;
        }
        throw error;
      }
      return await response.text();
    } catch (err) {
      lastError = err;
      const retryable = err instanceof HttpError ? RETRYABLE.has(err.status) : true;
      if (!retryable || attempt === retries) throw err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function fetchJson<T>(url: string, options: HttpOptions): Promise<T> {
  const text = await fetchText(url, {
    ...options,
    headers: { accept: 'application/json', ...options.headers },
  });
  return JSON.parse(text) as T;
}
