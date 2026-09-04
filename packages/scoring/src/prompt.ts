import type { Candidate } from './tickers.ts';

export type ScorablePost = {
  id: number;
  source: string;
  title: string;
  body: string | null;
  candidates: Candidate[];
};

/**
 * Body text sent per post. Long DD posts run to thousands of characters and the
 * sentiment is nearly always established early, so this caps quota burn without
 * costing much signal.
 */
const MAX_BODY_CHARS = 1200;

export const SYSTEM_PROMPT = `
You score financial sentiment in social media and news posts about US-listed equities.

For each post you are given a list of CANDIDATE tickers that a regex already
matched against the SEC's list of listed symbols. Your job is two decisions per
candidate:

1. is_ticker_mention -- is this post actually discussing that company or
   security? The same letters are often an ordinary word, an acronym, or a
   person's initials. "I did my own DD" is not DuPont. "That was an EPIC play"
   is not a ticker. Written as $NVDA it almost always is one. When the post
   never really discusses the company, set is_ticker_mention false and
   sentiment_score 0.

2. sentiment_score -- how the post feels about that security's prospects, from
   -1 (maximally bearish) through 0 (neutral, mixed, or purely factual) to
   1 (maximally bullish).

Score the author's stance toward the security, not the mood of the writing. A
cheerful post about buying puts is bearish. A furious rant about having sold
too early is bullish. Sarcasm and loss-porn are common on these forums; read
the position, not the tone. A factual headline with no view is 0.

Set confidence to reflect genuine ambiguity: short posts, mixed views across a
thread, or heavy sarcasm deserve lower confidence.

Return exactly one entry per input post, echoing its post_id, and exactly one
entry per candidate ticker supplied for that post. Never invent a ticker that
was not supplied, never omit a post, and never merge two posts together.
`.trim();

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}... [truncated]`;
}

/** Renders one batch of posts as the user turn. */
export function renderBatch(posts: ScorablePost[]): string {
  const blocks = posts.map((post) => {
    const candidates = post.candidates
      .map((c) => `${c.ticker} (${c.companyName})${c.cashtag ? ' [written as a cashtag]' : ''}`)
      .join(', ');

    const lines = [
      `<post id="${post.id}" source="${post.source}">`,
      `CANDIDATES: ${candidates}`,
      `TITLE: ${post.title}`,
    ];
    if (post.body?.trim()) lines.push(`BODY: ${truncate(post.body.trim(), MAX_BODY_CHARS)}`);
    lines.push('</post>');
    return lines.join('\n');
  });

  return [
    `Score the following ${posts.length} post(s). Return one result per post.`,
    '',
    blocks.join('\n\n'),
  ].join('\n');
}
