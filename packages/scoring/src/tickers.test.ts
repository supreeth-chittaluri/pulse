import { describe, expect, it } from 'vitest';
import {
  BARE_MENTION_STOPLIST,
  ETF_TICKERS,
  extractCandidates,
  loadTickers,
} from './tickers.ts';

// A small fixed allowlist keeps these assertions independent of SEC listing
// changes; the real committed list is exercised separately below.
const TICKERS = new Map([
  ['NVDA', 'NVIDIA CORP'],
  ['AMD', 'Advanced Micro Devices'],
  ['DD', 'DUPONT DE NEMOURS'],
  ['IT', 'Gartner Inc'],
  ['MP', 'MP Materials Corp'],
  ['TSLA', 'Tesla Inc'],
  ['A', 'Agilent Technologies'],
]);

const opts = { tickers: TICKERS };

describe('extractCandidates', () => {
  it('finds bare uppercase symbols on the allowlist', () => {
    expect(extractCandidates('NVDA is going to rip', opts).map((c) => c.ticker)).toEqual(['NVDA']);
  });

  it('finds cashtags and marks them', () => {
    const [candidate] = extractCandidates('loading up on $nvda calls', opts);
    expect(candidate).toMatchObject({ ticker: 'NVDA', cashtag: true });
  });

  it('attaches the company name for prompt disambiguation', () => {
    expect(extractCandidates('$MP squeeze', opts)[0]?.companyName).toBe('MP Materials Corp');
  });

  it('ignores symbols that are not on the allowlist', () => {
    expect(extractCandidates('ZZZZ to the moon', opts)).toEqual([]);
    expect(extractCandidates('$FAKE calls', opts)).toEqual([]);
  });

  // The core false-positive guard: these are all real listed symbols, and all
  // of them are ordinary words on r/wallstreetbets.
  it('suppresses stoplisted words written bare', () => {
    expect(extractCandidates('I did my own DD before buying', opts)).toEqual([]);
    expect(extractCandidates('IT department said no', opts)).toEqual([]);
    expect(extractCandidates('A is for apple', opts)).toEqual([]);
  });

  it('still accepts a stoplisted symbol written as a cashtag', () => {
    // "$DD" is an unambiguous statement of intent, unlike bare "DD".
    const [candidate] = extractCandidates('$DD earnings tomorrow', opts);
    expect(candidate).toMatchObject({ ticker: 'DD', cashtag: true });
  });

  it('does not match uppercase runs glued to other characters', () => {
    expect(extractCandidates('NVDAAAAA', opts)).toEqual([]);
    expect(extractCandidates('SOMETHING', opts)).toEqual([]);
  });

  it('ignores lowercase bare words', () => {
    // Otherwise "and", "the", "a" would light up constantly.
    expect(extractCandidates('nvda is nice but amd is nicer', opts)).toEqual([]);
  });

  it('deduplicates repeated mentions', () => {
    expect(extractCandidates('NVDA NVDA NVDA $NVDA', opts).map((c) => c.ticker)).toEqual(['NVDA']);
  });

  it('prefers the cashtag flag when a symbol appears both ways', () => {
    expect(extractCandidates('$NVDA and also NVDA', opts)[0]?.cashtag).toBe(true);
  });

  it('returns multiple candidates sorted', () => {
    expect(extractCandidates('TSLA vs NVDA vs AMD', opts).map((c) => c.ticker)).toEqual([
      'AMD',
      'NVDA',
      'TSLA',
    ]);
  });

  it('returns nothing for a post with no financial content', () => {
    // This is the case that keeps most of the queue off the model entirely.
    expect(extractCandidates('Show HN: I built a static site generator', opts)).toEqual([]);
  });
});

describe('committed SEC allowlist', () => {
  it('loads and contains the tickers we actually track', () => {
    const tickers = loadTickers();
    expect(tickers.size).toBeGreaterThan(5000);
    for (const symbol of ['NVDA', 'TSLA', 'AAPL', 'AMD', 'MSFT']) {
      expect(tickers.has(symbol)).toBe(true);
    }
  });

  it('holds only plain 1-5 letter symbols', () => {
    for (const symbol of loadTickers().keys()) {
      expect(symbol).toMatch(/^[A-Z]{1,5}$/);
    }
  });

  it('suppresses every stoplisted word that clashes with a real symbol', () => {
    // Entries that are not currently listed (delisted tickers, ETF symbols the
    // SEC file omits) are inert but deliberate -- they keep working if the
    // allowlist later grows. What must hold is that no stoplisted word slips
    // through as a bare candidate.
    for (const word of BARE_MENTION_STOPLIST) {
      expect(extractCandidates(`the ${word} thing`)).toEqual([]);
    }
  });

  it('covers the ETFs the SEC company list omits', () => {
    // company_tickers.json has operating companies only; SPY/QQQ/IWM are the
    // most-discussed symbols on these subreddits and would otherwise be
    // invisible to the extractor entirely.
    const tickers = loadTickers();
    for (const symbol of ['SPY', 'QQQ', 'IWM', 'TQQQ', 'GLD']) {
      expect(tickers.has(symbol)).toBe(true);
    }
    expect(extractCandidates('SPY calls printing').map((c) => c.ticker)).toEqual(['SPY']);
  });

  it('never lets an ETF entry shadow a listed company symbol', () => {
    const tickers = loadTickers();
    // GLD/SLV etc must not overwrite a company of the same symbol if one exists.
    for (const [symbol, etfName] of ETF_TICKERS) {
      const name = tickers.get(symbol);
      if (name !== etfName) expect(name).toBeDefined();
    }
  });
});
