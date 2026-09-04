/** A post as ingested from a source, before Claude has looked at it (M2). */
export type RawPost = {
  /** Registry source id, e.g. "reddit:wallstreetbets". */
  source: string;
  /** Stable id within that source. Half of the M1 dedupe key. */
  sourcePostId: string;
  title: string;
  body: string | null;
  url: string;
  author: string | null;
  postedAt: Date | null;
};

/** One (post x ticker) sentiment reading. Written by M2. */
export type Signal = {
  id: number;
  postId: number;
  source: string;
  tickerOrTopic: string;
  /** -1 (max bearish) .. +1 (max bullish). */
  sentimentScore: number;
  confidence: number | null;
  rawExcerpt: string;
  scrapedAt: Date;
};

export type UserRole = 'demo' | 'admin';
