/**
 * Grades the scoring prompt against hand-labeled posts.
 *
 *   node scripts/eval-scoring.ts            # re-score the labeled posts, then grade
 *   node scripts/eval-scoring.ts --stored   # grade what is already in signals (0 quota)
 *
 * Re-scoring costs a couple of requests against the daily quota, which is the
 * honest default while iterating on the prompt -- grading stale rows would tell
 * you how a prompt you already changed used to behave.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createLogger, loadConfig } from '@pulse/core';
import { createPool } from '../packages/core/src/db.ts';
import { MinIntervalGate } from '@pulse/sources';
import {
  createGeminiModel,
  extractCandidates,
  parseBatchResponse,
  renderBatch,
  SYSTEM_PROMPT,
  type ScorablePost,
} from '@pulse/scoring';

const LABELS = resolve(dirname(fileURLToPath(import.meta.url)), '../eval/labels.jsonl');

/** Anything inside this band counts as neutral for sign agreement. */
const NEUTRAL_BAND = 0.2;

type Label = {
  post_id: number;
  source: string;
  title: string;
  body: string | null;
  labels: Array<{
    ticker: string;
    label_is_ticker: boolean | null;
    label_sentiment: number | null;
  }>;
};

type Prediction = { isTicker: boolean; sentiment: number };

function sign(score: number): 'bullish' | 'bearish' | 'neutral' {
  if (score > NEUTRAL_BAND) return 'bullish';
  if (score < -NEUTRAL_BAND) return 'bearish';
  return 'neutral';
}

function pct(n: number, d: number): string {
  return d === 0 ? '  n/a' : `${((100 * n) / d).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { stored: { type: 'boolean', default: false } } });

  const raw = readFileSync(LABELS, 'utf8').trim().split('\n').filter(Boolean);
  const all = raw.map((line) => JSON.parse(line) as Label);

  const labeled = all.filter((entry) =>
    entry.labels.some((l) => l.label_is_ticker !== null || l.label_sentiment !== null),
  );
  const unlabeled = all.length - labeled.length;

  if (labeled.length === 0) {
    console.error(
      `No labels filled in yet in ${LABELS}.\n` +
        'Set label_is_ticker and label_sentiment on each entry, then re-run.',
    );
    process.exit(1);
  }
  if (unlabeled > 0) {
    console.log(`Note: ${unlabeled} of ${all.length} posts are unlabeled and will be skipped.\n`);
  }

  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  const predictions = new Map<string, Prediction>();
  let requestsUsed = 0;

  if (values.stored) {
    const { rows } = await pool.query<{
      post_id: string;
      ticker_or_topic: string;
      sentiment_score: number;
    }>(
      'select post_id, ticker_or_topic, sentiment_score from signals where post_id = any($1::bigint[])',
      [labeled.map((l) => l.post_id)],
    );
    for (const row of rows) {
      predictions.set(`${row.post_id}:${row.ticker_or_topic}`, {
        // A stored signal exists only when the model said it was a real mention.
        isTicker: true,
        sentiment: row.sentiment_score,
      });
    }
  } else {
    if (!config.gemini.apiKey) throw new Error('GEMINI_API_KEY is required (or pass --stored)');
    const model = createGeminiModel({ apiKey: config.gemini.apiKey, model: config.gemini.model });
    const gate = new MinIntervalGate(config.gemini.minIntervalMs);

    for (let i = 0; i < labeled.length; i += config.scoring.batchSize) {
      const batch = labeled.slice(i, i + config.scoring.batchSize);
      const scorable: ScorablePost[] = batch.map((entry) => ({
        id: entry.post_id,
        source: entry.source,
        title: entry.title,
        body: entry.body,
        candidates: extractCandidates(entry.body ? `${entry.title}\n${entry.body}` : entry.title),
      }));

      await gate.acquire('gemini');
      const response = await model.generate(SYSTEM_PROMPT, renderBatch(scorable));
      requestsUsed += 1;

      for (const result of parseBatchResponse(
        response.text,
        scorable.map((p) => p.id),
      ).results) {
        for (const verdict of result.tickers) {
          predictions.set(`${result.post_id}:${verdict.ticker}`, {
            isTicker: verdict.is_ticker_mention,
            sentiment: verdict.sentiment_score,
          });
        }
      }
    }
  }

  // --- grade ---------------------------------------------------------------
  let truePos = 0;
  let falsePos = 0;
  let falseNeg = 0;
  let signAgree = 0;
  let signTotal = 0;
  let absError = 0;
  const misses: string[] = [];

  for (const entry of labeled) {
    for (const label of entry.labels) {
      const predicted = predictions.get(`${entry.post_id}:${label.ticker}`);
      const predictedIsTicker = predicted?.isTicker ?? false;

      if (label.label_is_ticker !== null) {
        if (label.label_is_ticker && predictedIsTicker) truePos += 1;
        else if (!label.label_is_ticker && predictedIsTicker) falsePos += 1;
        else if (label.label_is_ticker && !predictedIsTicker) falseNeg += 1;
      }

      // Sentiment is only meaningful where both sides agree it IS a mention.
      if (label.label_sentiment !== null && label.label_is_ticker && predictedIsTicker) {
        signTotal += 1;
        absError += Math.abs(predicted!.sentiment - label.label_sentiment);
        if (sign(predicted!.sentiment) === sign(label.label_sentiment)) signAgree += 1;
        else {
          misses.push(
            `  ${label.ticker.padEnd(6)} labeled ${label.label_sentiment.toFixed(2).padStart(5)} ` +
              `(${sign(label.label_sentiment)}), predicted ${predicted!.sentiment.toFixed(2).padStart(5)} ` +
              `(${sign(predicted!.sentiment)})  ${entry.title.slice(0, 52)}`,
          );
        }
      }
    }
  }

  const precision = truePos + falsePos === 0 ? 0 : truePos / (truePos + falsePos);
  const recall = truePos + falseNeg === 0 ? 0 : truePos / (truePos + falseNeg);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  console.log(`\nScoring eval -- ${config.gemini.model}${values.stored ? ' (stored signals)' : ''}`);
  console.log(`posts graded: ${labeled.length}   requests used: ${requestsUsed}\n`);
  console.log('Ticker mention classification');
  console.log(`  precision   ${(100 * precision).toFixed(1)}%   (${truePos} correct of ${truePos + falsePos} predicted)`);
  console.log(`  recall      ${(100 * recall).toFixed(1)}%   (${truePos} found of ${truePos + falseNeg} real)`);
  console.log(`  F1          ${(100 * f1).toFixed(1)}%`);
  console.log('\nSentiment (where both agree it is a real mention)');
  console.log(`  sign agreement  ${pct(signAgree, signTotal)}   (${signAgree}/${signTotal})`);
  console.log(`  mean abs error  ${signTotal === 0 ? 'n/a' : (absError / signTotal).toFixed(3)}`);

  if (misses.length > 0) {
    console.log(`\nDisagreements (${misses.length}):`);
    for (const miss of misses) console.log(miss);
  }
  console.log('');

  await pool.end();
}

main().catch((err: unknown) => {
  console.error(`\n${(err as Error).message}\n`);
  process.exit(1);
});
