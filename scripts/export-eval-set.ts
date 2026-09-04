/**
 * Exports a stratified sample of scored posts as a labeling worksheet.
 *
 *   node scripts/export-eval-set.ts [count]
 *
 * The model's own predictions are deliberately NOT included. If the labels were
 * anchored on what the model already said, the eval would mostly measure
 * agreement with itself rather than correctness -- and since the same author
 * wrote the prompt, that circularity would be invisible in the final number.
 *
 * Fill in `label_sentiment` (-1..1) and `label_is_ticker` (true/false) for each
 * candidate, then `npm run eval:scoring` grades the model against your answers.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadConfig } from '../packages/core/src/config.ts';
import { createPool } from '../packages/core/src/db.ts';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../eval/labels.jsonl');

type Row = {
  id: string;
  source: string;
  title: string;
  body: string | null;
  tickers: string[];
};

async function main(): Promise<void> {
  const count = Number.parseInt(process.argv[2] ?? '25', 10);
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);

  // Stratify across sources and across the sentiment range, so the sample is
  // not 25 variations of "WSB user posts gain porn".
  const { rows } = await pool.query<Row>(
    `with scored as (
       select p.id, p.source, p.title, p.body,
              array_agg(s.ticker_or_topic order by s.ticker_or_topic) as tickers,
              avg(s.sentiment_score) as avg_sentiment,
              row_number() over (
                partition by p.source, width_bucket(avg(s.sentiment_score), -1, 1, 4)
                order by random()
              ) as rn
         from posts p
         join signals s on s.post_id = p.id
        group by p.id
     )
     select id, source, title, body, tickers
       from scored
      where rn <= 3
      order by random()
      limit $1`,
    [count],
  );

  const lines = rows.map((row) =>
    JSON.stringify({
      post_id: Number(row.id),
      source: row.source,
      title: row.title,
      body: row.body?.slice(0, 800) ?? null,
      labels: row.tickers.map((ticker) => ({
        ticker,
        // Is this post really discussing the company/security?
        label_is_ticker: null,
        // -1 (max bearish) .. 0 (neutral/mixed/factual) .. 1 (max bullish).
        // Score the author's stance on the security, not the mood of the text.
        label_sentiment: null,
      })),
    }),
  );

  writeFileSync(OUT, `${lines.join('\n')}\n`);
  console.log(`Wrote ${rows.length} posts to ${OUT}`);
  console.log(`${lines.reduce((n, l) => n + (JSON.parse(l).labels.length as number), 0)} ticker judgements to fill in.`);
  await pool.end();
}

main().catch((err: unknown) => {
  console.error((err as Error).message);
  process.exit(1);
});
