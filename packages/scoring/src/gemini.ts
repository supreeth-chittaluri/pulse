import { GoogleGenAI } from '@google/genai';
import { GEMINI_RESPONSE_SCHEMA } from './schema.ts';

export type GenerateResult = {
  /** Raw JSON text. Validation happens in schema.ts, never here. */
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
};

/**
 * Minimal seam over the provider. Everything above this file works against this
 * interface, so the tests need no network and swapping providers again would
 * touch one file.
 */
export interface ScoringModel {
  readonly provider: string;
  readonly model: string;
  generate(systemPrompt: string, userPrompt: string): Promise<GenerateResult>;
}

export class QuotaExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuotaExceededError';
  }
}

function isQuotaError(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  const message = (err as Error)?.message ?? '';
  return status === 429 || /RESOURCE_EXHAUSTED|quota|rate limit/i.test(message);
}

export type GeminiOptions = { apiKey: string; model: string };

/**
 * Gemini via the Interactions API.
 *
 * Structured output goes through `response_format`, which Gemini constrains the
 * generation to satisfy -- the older `generationConfig.responseSchema` path is
 * deprecated in the SDK. Note that Gemini honours only a subset of JSON Schema
 * (no numeric minimum/maximum), which is exactly why the validation layer in
 * schema.ts re-checks every bound itself rather than trusting the provider.
 */
export function createGeminiModel(options: GeminiOptions): ScoringModel {
  const client = new GoogleGenAI({ apiKey: options.apiKey });

  return {
    provider: 'gemini',
    model: options.model,

    async generate(systemPrompt: string, userPrompt: string): Promise<GenerateResult> {
      const startedAt = Date.now();
      try {
        const interaction = await client.interactions.create({
          model: options.model,
          system_instruction: systemPrompt,
          input: userPrompt,
          response_format: {
            type: 'text',
            mime_type: 'application/json',
            schema: GEMINI_RESPONSE_SCHEMA as unknown as Record<string, unknown>,
          },
        });

        const text = interaction.output_text;
        if (!text) {
          throw new Error(
            `Model returned no text output (status: ${String(interaction.status)})`,
          );
        }

        return {
          text,
          inputTokens: interaction.usage?.total_input_tokens ?? null,
          outputTokens: interaction.usage?.total_output_tokens ?? null,
          durationMs: Date.now() - startedAt,
        };
      } catch (err) {
        if (isQuotaError(err)) {
          throw new QuotaExceededError(
            `Gemini quota or rate limit hit: ${(err as Error).message}\n` +
              'Check your project limits at https://aistudio.google.com/rate-limit',
          );
        }
        throw err;
      }
    },
  };
}
