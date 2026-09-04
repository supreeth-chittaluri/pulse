import { describe, expect, it } from 'vitest';
import { GEMINI_RESPONSE_SCHEMA, ValidationError, parseBatchResponse } from './schema.ts';

function response(results: unknown): string {
  return JSON.stringify({ results });
}

const validEntry = {
  post_id: 1,
  tickers: [
    {
      ticker: 'NVDA',
      is_ticker_mention: true,
      sentiment_score: 0.8,
      confidence: 0.9,
      rationale: 'author is buying calls',
    },
  ],
};

describe('parseBatchResponse', () => {
  it('accepts a well-formed response', () => {
    const parsed = parseBatchResponse(response([validEntry]), [1]);
    expect(parsed.results[0]?.tickers[0]).toMatchObject({ ticker: 'NVDA', sentiment_score: 0.8 });
  });

  it('accepts a post with no ticker verdicts', () => {
    const parsed = parseBatchResponse(response([{ post_id: 1, tickers: [] }]), [1]);
    expect(parsed.results[0]?.tickers).toEqual([]);
  });

  it('rejects non-JSON', () => {
    expect(() => parseBatchResponse('not json at all', [1])).toThrow(ValidationError);
  });

  it('rejects a missing results array', () => {
    expect(() => parseBatchResponse('{}', [1])).toThrow(/did not match the expected schema/);
  });

  // Gemini's structured output honours only a subset of JSON Schema and does
  // NOT enforce numeric minimum/maximum, so these bounds are ours to check.
  // Switching providers must never quietly drop them.
  it('rejects a sentiment score outside -1..1', () => {
    for (const score of [1.5, -2, 99]) {
      const entry = { ...validEntry, tickers: [{ ...validEntry.tickers[0]!, sentiment_score: score }] };
      expect(() => parseBatchResponse(response([entry]), [1])).toThrow(ValidationError);
    }
  });

  it('rejects a confidence outside 0..1', () => {
    for (const confidence of [-0.1, 1.2]) {
      const entry = { ...validEntry, tickers: [{ ...validEntry.tickers[0]!, confidence }] };
      expect(() => parseBatchResponse(response([entry]), [1])).toThrow(ValidationError);
    }
  });

  it('rejects a malformed ticker symbol', () => {
    for (const ticker of ['', 'TOOLONG', 'NV DA', '123']) {
      const entry = { ...validEntry, tickers: [{ ...validEntry.tickers[0]!, ticker }] };
      expect(() => parseBatchResponse(response([entry]), [1])).toThrow(ValidationError);
    }
  });

  it('normalizes ticker case', () => {
    const entry = { ...validEntry, tickers: [{ ...validEntry.tickers[0]!, ticker: 'nvda' }] };
    expect(parseBatchResponse(response([entry]), [1]).results[0]?.tickers[0]?.ticker).toBe('NVDA');
  });

  it('rejects a non-boolean is_ticker_mention', () => {
    const entry = { ...validEntry, tickers: [{ ...validEntry.tickers[0]!, is_ticker_mention: 'yes' }] };
    expect(() => parseBatchResponse(response([entry]), [1])).toThrow(ValidationError);
  });

  // The invariant that actually protects the data. Batching 15 posts into one
  // request invites the model to drop, duplicate, or invent an entry, and a
  // shuffled result would silently attach one post's sentiment to another.
  describe('post_id alignment', () => {
    it('rejects a missing post', () => {
      expect(() => parseBatchResponse(response([validEntry]), [1, 2])).toThrow(
        /post_ids do not match/,
      );
    });

    it('rejects an invented post', () => {
      const extra = { ...validEntry, post_id: 99 };
      expect(() => parseBatchResponse(response([validEntry, extra]), [1])).toThrow(
        /post_ids do not match/,
      );
    });

    it('rejects a duplicated post', () => {
      expect(() => parseBatchResponse(response([validEntry, validEntry]), [1])).toThrow(
        /same post twice/,
      );
    });

    it('accepts results returned out of order', () => {
      const two = { ...validEntry, post_id: 2 };
      const parsed = parseBatchResponse(response([two, validEntry]), [1, 2]);
      expect(parsed.results.map((r) => r.post_id).sort()).toEqual([1, 2]);
    });

    it('names what was missing or unexpected', () => {
      try {
        parseBatchResponse(response([{ ...validEntry, post_id: 7 }]), [1]);
        expect.unreachable();
      } catch (err) {
        expect((err as ValidationError).detail).toContain('missing [1]');
        expect((err as ValidationError).detail).toContain('unexpected [7]');
      }
    });
  });
});

describe('GEMINI_RESPONSE_SCHEMA', () => {
  it('uses only JSON Schema features Gemini supports', () => {
    // Gemini honours a subset: types, properties, required, items, enum,
    // description. Anything else is silently ignored, so asserting their
    // absence keeps us from believing the API is enforcing something it isn't.
    const unsupported = ['minimum', 'maximum', 'anyOf', 'oneOf', 'allOf', 'not', 'pattern'];
    const serialized = JSON.stringify(GEMINI_RESPONSE_SCHEMA);
    for (const keyword of unsupported) {
      expect(serialized).not.toContain(`"${keyword}"`);
    }
  });

  it('requires every field the validation layer requires', () => {
    const item = GEMINI_RESPONSE_SCHEMA.properties.results.items.properties.tickers.items;
    expect([...item.required]).toEqual([
      'ticker',
      'is_ticker_mention',
      'sentiment_score',
      'confidence',
      'rationale',
    ]);
  });
});
