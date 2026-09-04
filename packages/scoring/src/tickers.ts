import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Candidate extraction: the free, deterministic half of scoring.
 *
 * The model is never asked to find tickers from scratch. A regex plus the SEC
 * allowlist proposes candidates, and the model only judges whether each one is
 * really a ticker mention in context and how the post feels about it. That
 * keeps the expensive step small and makes this half unit-testable.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TICKERS_PATH = resolve(HERE, '../../../config/tickers.json');

/**
 * Real listed symbols that are overwhelmingly ordinary words on these feeds.
 * A bare "DD" on r/wallstreetbets means due diligence roughly always, and
 * DuPont approximately never -- but "$DD" is unambiguous, so the stoplist only
 * applies to bare mentions.
 */
export const BARE_MENTION_STOPLIST = new Set([
  'A', 'ALL', 'AN', 'AND', 'ANY', 'ARE', 'AT', 'BE', 'BIG', 'BUY', 'BY', 'CAN',
  'CEO', 'CFO', 'DD', 'DO', 'EAT', 'EOD', 'EU', 'EV', 'FOR', 'FREE', 'FUN',
  'GO', 'GOOD', 'HAS', 'HE', 'HIT', 'HOLD', 'HOPE', 'IM', 'IMO', 'IN', 'INFO',
  'IPO', 'IS', 'IT', 'ITS', 'JOB', 'K', 'LOVE', 'LOW', 'MAX', 'ME', 'MO', 'NEW',
  'NEXT', 'NO', 'NOW', 'OF', 'OG', 'OK', 'ON', 'ONE', 'OPEN', 'OR', 'OTC',
  'OUT', 'PLAY', 'POST', 'PT', 'PUT', 'REAL', 'RH', 'RIP', 'SAFE', 'SEE', 'SO',
  'TA', 'TELL', 'TO', 'TRUE', 'TRY', 'TV', 'UK', 'UP', 'US', 'USA', 'VERY',
  'WELL', 'WHO', 'WIN', 'WORK', 'YOLO', 'YOU',
]);

/**
 * The SEC's company_tickers.json lists operating companies only -- it contains
 * no ETFs. Without this, SPY / QQQ / IWM would never be detected, and those are
 * among the most-discussed symbols on every subreddit we track. Curated by hand
 * because there is no equivalent free authoritative ETF feed.
 */
export const ETF_TICKERS: ReadonlyArray<readonly [string, string]> = [
  ['SPY', 'SPDR S&P 500 ETF Trust'],
  ['QQQ', 'Invesco QQQ Trust'],
  ['IWM', 'iShares Russell 2000 ETF'],
  ['DIA', 'SPDR Dow Jones Industrial Average ETF'],
  ['VOO', 'Vanguard S&P 500 ETF'],
  ['VTI', 'Vanguard Total Stock Market ETF'],
  ['ARKK', 'ARK Innovation ETF'],
  ['TQQQ', 'ProShares UltraPro QQQ'],
  ['SQQQ', 'ProShares UltraPro Short QQQ'],
  ['SOXL', 'Direxion Daily Semiconductor Bull 3X'],
  ['SOXS', 'Direxion Daily Semiconductor Bear 3X'],
  ['SMH', 'VanEck Semiconductor ETF'],
  ['GLD', 'SPDR Gold Shares'],
  ['SLV', 'iShares Silver Trust'],
  ['TLT', 'iShares 20+ Year Treasury Bond ETF'],
  ['HYG', 'iShares iBoxx High Yield Corporate Bond ETF'],
  ['XLF', 'Financial Select Sector SPDR Fund'],
  ['XLE', 'Energy Select Sector SPDR Fund'],
  ['XLK', 'Technology Select Sector SPDR Fund'],
  ['UVXY', 'ProShares Ultra VIX Short-Term Futures'],
  ['VXX', 'iPath Series B S&P 500 VIX Short-Term Futures'],
  ['UPRO', 'ProShares UltraPro S&P 500'],
  ['SPXU', 'ProShares UltraPro Short S&P 500'],
];

export type TickerEntry = { ticker: string; name: string };

let cache: Map<string, string> | undefined;

/** Loads the committed SEC allowlist. Cached after the first call. */
export function loadTickers(path: string = DEFAULT_TICKERS_PATH): Map<string, string> {
  if (cache) return cache;
  let parsed: { tickers?: TickerEntry[] };
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as { tickers?: TickerEntry[] };
  } catch (err) {
    throw new Error(
      `Could not read the ticker allowlist at ${path}: ${(err as Error).message}\n` +
        'Run `node scripts/refresh-tickers.ts` to regenerate it.',
      { cause: err },
    );
  }
  if (!parsed.tickers?.length) throw new Error(`Ticker allowlist at ${path} is empty`);

  const merged = new Map(parsed.tickers.map((t) => [t.ticker, t.name]));
  // ETFs are additive: never let one shadow a real listed company symbol.
  for (const [symbol, name] of ETF_TICKERS) {
    if (!merged.has(symbol)) merged.set(symbol, name);
  }

  cache = merged;
  return cache;
}

export function resetTickerCache(): void {
  cache = undefined;
}

export type Candidate = {
  ticker: string;
  companyName: string;
  /** True when written as $NVDA, which bypasses the stoplist. */
  cashtag: boolean;
};

// $NVDA, or a bare 1-5 letter uppercase run not glued to other word characters.
const CASHTAG = /\$([A-Za-z]{1,5})\b/g;
const BARE_UPPER = /\b([A-Z]{1,5})\b/g;

/**
 * Finds plausible ticker mentions in a post.
 *
 * A post with no candidates never reaches the model at all -- it is marked
 * scored with zero signals, at zero quota cost. On general Hacker News and
 * off-topic Reddit chatter that is most of the queue.
 */
export function extractCandidates(
  text: string,
  options: { tickers?: Map<string, string>; stoplist?: Set<string> } = {},
): Candidate[] {
  const tickers = options.tickers ?? loadTickers();
  const stoplist = options.stoplist ?? BARE_MENTION_STOPLIST;
  const found = new Map<string, Candidate>();

  for (const match of text.matchAll(CASHTAG)) {
    const symbol = match[1]!.toUpperCase();
    const name = tickers.get(symbol);
    // An explicit cashtag is an unambiguous signal of intent, so it skips the
    // stoplist -- but it still has to be a real listed symbol.
    if (name) found.set(symbol, { ticker: symbol, companyName: name, cashtag: true });
  }

  for (const match of text.matchAll(BARE_UPPER)) {
    const symbol = match[1]!;
    if (found.has(symbol) || stoplist.has(symbol)) continue;
    const name = tickers.get(symbol);
    if (name) found.set(symbol, { ticker: symbol, companyName: name, cashtag: false });
  }

  return [...found.values()].sort((a, b) => a.ticker.localeCompare(b.ticker));
}
