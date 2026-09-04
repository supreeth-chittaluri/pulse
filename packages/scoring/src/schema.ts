import { z } from 'zod';

/**
 * The model's output contract, defined twice on purpose.
 *
 * `GEMINI_RESPONSE_SCHEMA` is what the API is given. Gemini's structured output
 * supports only a SUBSET of JSON Schema -- notably it does not enforce numeric
 * `minimum`/`maximum` -- so it constrains shape and nothing more.
 *
 * `batchResultSchema` is what we actually trust. Every range, every enum, every
 * cross-field invariant is enforced here, on our side, after parsing. Switching
 * providers must never quietly weaken this layer.
 */

export const GEMINI_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      description: 'One entry per input post, in any order.',
      items: {
        type: 'object',
        properties: {
          post_id: {
            type: 'integer',
            description: 'Echo the post_id given in the input exactly.',
          },
          tickers: {
            type: 'array',
            description: 'One entry per candidate ticker supplied for this post.',
            items: {
              type: 'object',
              properties: {
                ticker: { type: 'string', description: 'The candidate symbol, uppercase.' },
                is_ticker_mention: {
                  type: 'boolean',
                  description:
                    'True only if this post is really discussing the company/security. ' +
                    'False when the letters are being used as an ordinary word or acronym.',
                },
                sentiment_score: {
                  type: 'number',
                  description:
                    'Sentiment toward this security, -1 (maximally bearish) to 1 ' +
                    '(maximally bullish). 0 when neutral or not a ticker mention.',
                },
                confidence: {
                  type: 'number',
                  description: 'Confidence in the above, 0 to 1.',
                },
                rationale: {
                  type: 'string',
                  description: 'One short clause justifying the score. Under 120 characters.',
                },
              },
              required: [
                'ticker',
                'is_ticker_mention',
                'sentiment_score',
                'confidence',
                'rationale',
              ],
            },
          },
        },
        required: ['post_id', 'tickers'],
      },
    },
  },
  required: ['results'],
} as const;

/** Ranges the API schema cannot express, enforced here instead. */
export const tickerVerdictSchema = z.object({
  ticker: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{1,5}$/, 'ticker must be 1-5 letters'),
  is_ticker_mention: z.boolean(),
  sentiment_score: z.number().min(-1).max(1),
  confidence: z.number().min(0).max(1),
  rationale: z.string().max(500),
});

export const postResultSchema = z.object({
  post_id: z.number().int().positive(),
  tickers: z.array(tickerVerdictSchema),
});

export const batchResultSchema = z.object({
  results: z.array(postResultSchema),
});

export type TickerVerdict = z.infer<typeof tickerVerdictSchema>;
export type PostResult = z.infer<typeof postResultSchema>;
export type BatchResult = z.infer<typeof batchResultSchema>;

export class ValidationError extends Error {
  readonly detail: string;
  constructor(message: string, detail: string) {
    super(message);
    this.name = 'ValidationError';
    this.detail = detail;
  }
}

/**
 * Parses and validates a raw model response.
 *
 * Beyond the schema, this enforces the invariant that actually protects the
 * data: the set of post_ids returned must match the set sent, exactly. Batching
 * 15 posts into one request invites the model to drop, duplicate, or invent an
 * entry, and a shuffled result would attach one post's sentiment to another
 * post's row with nothing downstream able to detect it.
 */
export function parseBatchResponse(rawJson: string, expectedPostIds: number[]): BatchResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    throw new ValidationError('Model response was not valid JSON', (err as Error).message);
  }

  const result = batchResultSchema.safeParse(parsed);
  if (!result.success) {
    throw new ValidationError(
      'Model response did not match the expected schema',
      result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  }

  const expected = new Set(expectedPostIds);
  const returned = new Set<number>();
  for (const entry of result.data.results) {
    if (returned.has(entry.post_id)) {
      throw new ValidationError(
        'Model returned the same post twice',
        `duplicate post_id ${entry.post_id}`,
      );
    }
    returned.add(entry.post_id);
  }

  const missing = [...expected].filter((id) => !returned.has(id));
  const unexpected = [...returned].filter((id) => !expected.has(id));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new ValidationError(
      'Model response post_ids do not match the request',
      `missing [${missing.join(', ')}], unexpected [${unexpected.join(', ')}]`,
    );
  }

  return result.data;
}
