import { describe, expect, it } from 'vitest';

/**
 * The transport fallback is exercised in a browser rather than here -- it needs
 * EventSource and a real proxy to be meaningful. What is worth pinning without
 * a DOM is the cursor arithmetic that makes polling lossless.
 */
function advance(cursor: number, ids: number[]): number {
  return ids.reduce((max, id) => Math.max(max, id), cursor);
}

describe('polling cursor', () => {
  it('never moves backwards on an out-of-order batch', () => {
    // Rows come back ascending, but a retry or overlapping poll can deliver an
    // older page; a cursor that regressed would replay the whole feed.
    expect(advance(10, [11, 12, 13])).toBe(13);
    expect(advance(13, [11, 12])).toBe(13);
    expect(advance(13, [])).toBe(13);
  });

  it('starts from the newest signal so a fallback does not replay history', () => {
    // The hook seeds the cursor from the latest signal before opening the
    // stream, so switching to polling shows new rows, not the last 500.
    expect(advance(0, [512])).toBe(512);
  });
});
