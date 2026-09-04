/**
 * Small statistics helpers. Pure functions, no I/O, no dependencies -- the
 * whole point of this package is that spike detection can be tested exhaustively
 * without a database or a network.
 */

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

/**
 * Sample standard deviation (n-1). The observations are a sample of a ticker's
 * behaviour, not its entire population, so Bessel's correction applies -- with
 * n as small as 20 the difference is not cosmetic.
 *
 * Returns 0 for fewer than two values: undefined, not zero, but callers apply a
 * variance floor anyway and 0 makes that path explicit.
 */
export function stddev(values: number[], knownMean?: number): number {
  if (values.length < 2) return 0;
  const mu = knownMean ?? mean(values);
  let sumSquares = 0;
  for (const value of values) {
    const delta = value - mu;
    sumSquares += delta * delta;
  }
  return Math.sqrt(sumSquares / (values.length - 1));
}

/**
 * How many standard errors the observed value sits from the baseline mean.
 *
 * `spread` must already have any floor applied; this function will not divide
 * by zero but it will not silently invent a floor either.
 */
export function zScore(observed: number, baselineMean: number, spread: number): number {
  if (!Number.isFinite(spread) || spread <= 0) return 0;
  return (observed - baselineMean) / spread;
}

/**
 * Standard error of a mean of `sampleSize` observations.
 *
 * This is the correction that makes sentiment spikes work. Comparing a mean of
 * ten observations against the standard deviation of INDIVIDUAL observations
 * understates the deviation by a factor of sqrt(10): a genuine swing of +0.6
 * against an individual-level stddev of 0.4 looks like a forgettable z=1.5,
 * when as a mean of ten it is z=4.7. Averages are far less noisy than the
 * things they average, and the detector has to account for that or it will
 * quietly miss every real sentiment shift.
 */
export function standardError(populationStddev: number, sampleSize: number): number {
  if (sampleSize <= 0) return populationStddev;
  return populationStddev / Math.sqrt(sampleSize);
}

/**
 * Variance floor for count data.
 *
 * Mention counts are roughly Poisson, where variance equals the mean, so
 * sqrt(mean) is a principled lower bound on the spread rather than an arbitrary
 * fudge. Without it a ticker that sat at exactly zero all week has stddev 0 and
 * a single mention scores infinity.
 */
export function countSpreadFloor(baselineMean: number, absoluteFloor = 0.5): number {
  return Math.max(Math.sqrt(Math.max(baselineMean, 0)), absoluteFloor);
}
