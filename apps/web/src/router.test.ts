import { describe, expect, it } from 'vitest';
import { hrefFor, parseRoute } from './router.ts';

describe('parseRoute', () => {
  it('treats an empty or unknown hash as the overview', () => {
    for (const hash of ['', '#', '#/', '#/nonsense']) {
      expect(parseRoute(hash)).toEqual({ name: 'overview' });
    }
  });

  it('routes the list and the detail page off the same segment', () => {
    expect(parseRoute('#/tickers')).toEqual({ name: 'tickers' });
    expect(parseRoute('#/tickers/nvda')).toEqual({ name: 'ticker', symbol: 'NVDA' });
  });

  it('round-trips every route through its href', () => {
    const routes = [
      { name: 'overview' },
      { name: 'tickers' },
      { name: 'ticker', symbol: 'AAPL' },
      { name: 'spikes' },
      { name: 'scoring' },
      { name: 'watchlist' },
    ] as const;
    for (const route of routes) {
      expect(parseRoute(hrefFor(route))).toEqual(route);
    }
  });

  it('ignores a query string after the path', () => {
    expect(parseRoute('#/tickers/tsla?hours=24')).toEqual({ name: 'ticker', symbol: 'TSLA' });
  });
});
