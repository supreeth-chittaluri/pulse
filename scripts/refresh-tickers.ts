/**
 * Regenerates config/tickers.json from the SEC's official company_tickers.json.
 *
 *   node scripts/refresh-tickers.ts
 *
 * The list is committed so tests are hermetic and the worker needs no network
 * call to start. Re-run it occasionally; listings change slowly.
 *
 * The SEC requires a descriptive User-Agent with contact details on automated
 * requests -- see https://www.sec.gov/os/webmaster-faq#developers
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadConfig } from '../packages/core/src/config.ts';

const SEC_URL = 'https://www.sec.gov/files/company_tickers.json';
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../config/tickers.json');

type SecEntry = { cik_str: number; ticker: string; title: string };

async function main(): Promise<void> {
  const config = loadConfig();
  console.log(`Fetching ${SEC_URL} ...`);

  const response = await fetch(SEC_URL, { headers: { 'user-agent': config.userAgent } });
  if (!response.ok) {
    throw new Error(`SEC returned HTTP ${response.status}. Check USER_AGENT in .env.`);
  }

  const raw = (await response.json()) as Record<string, SecEntry>;
  const seen = new Set<string>();
  const tickers: Array<{ ticker: string; name: string }> = [];

  for (const entry of Object.values(raw)) {
    const ticker = entry.ticker?.trim().toUpperCase();
    // Skip class-share tickers with punctuation (BRK-B) and anything that is
    // not a plain 1-5 letter symbol -- the extractor only matches those.
    if (!ticker || !/^[A-Z]{1,5}$/.test(ticker) || seen.has(ticker)) continue;
    seen.add(ticker);
    tickers.push({ ticker, name: entry.title });
  }

  tickers.sort((a, b) => a.ticker.localeCompare(b.ticker));
  writeFileSync(
    OUT,
    `${JSON.stringify({ source: SEC_URL, retrievedAt: new Date().toISOString(), tickers }, null, 0)}\n`,
  );
  console.log(`Wrote ${tickers.length} tickers to ${OUT}`);
}

main().catch((err: unknown) => {
  console.error((err as Error).message);
  process.exit(1);
});
