import { useCallback, useEffect, useState } from 'react';

/**
 * Hash routing, deliberately.
 *
 * The dashboard is served as static files by the same Express process that
 * serves the API. History routing would need a catch-all rewrite that also has
 * to not swallow /api and /health, and getting that wrong breaks the API rather
 * than the page. A hash costs one character in the URL and cannot fight the
 * server for a path.
 */
export type Route =
  | { name: 'overview' }
  | { name: 'tickers' }
  | { name: 'ticker'; symbol: string }
  | { name: 'spikes' }
  | { name: 'scoring' }
  | { name: 'watchlist' };

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#\/?/, '').split('?')[0] ?? '';
  const [head, tail] = path.split('/');

  switch (head) {
    case 'tickers':
      return tail ? { name: 'ticker', symbol: decodeURIComponent(tail).toUpperCase() } : { name: 'tickers' };
    case 'spikes':
      return { name: 'spikes' };
    case 'scoring':
      return { name: 'scoring' };
    case 'watchlist':
      return { name: 'watchlist' };
    default:
      return { name: 'overview' };
  }
}

export function hrefFor(route: Route): string {
  switch (route.name) {
    case 'overview':
      return '#/';
    case 'ticker':
      return `#/tickers/${encodeURIComponent(route.symbol)}`;
    default:
      return `#/${route.name}`;
  }
}

export function useRoute(): [Route, (route: Route) => void] {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));

  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  const navigate = useCallback((next: Route) => {
    const href = hrefFor(next);
    if (window.location.hash === href) return;
    window.location.hash = href;
  }, []);

  return [route, navigate];
}
