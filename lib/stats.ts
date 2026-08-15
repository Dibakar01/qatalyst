/**
 * How sure are we, actually.
 *
 * This module exists because the advice engine used to assert its thresholds:
 * forty sends and it would call a winner. Published cold-outbound benchmarks
 * put the median reply rate at about 3.4%, and at that base rate telling a
 * genuine doubling apart — 3% against 6% — takes on the order of 750 sends per
 * variant. Forty was wrong by nearly twenty times, so every "winner" it ever
 * declared was noise.
 *
 * The fix is not a bigger constant. It is to stop asserting and start
 * measuring, which is what these functions do.
 */

/** 95%. The one place to change it. */
const Z = 1.959964

export type Interval = {
  /** Observed rate, which on its own is the number that misleads. */
  rate: number
  low: number
  high: number
  n: number
  k: number
}

/**
 * The Wilson score interval.
 *
 * Chosen over the textbook normal approximation because this data is exactly
 * where that one fails: small samples and rates near zero. At 1 success in 40
 * the normal approximation puts the lower bound *below zero*, which is not a
 * probability. Wilson stays inside [0, 1] by construction and stays honest at
 * the extremes — 0 of 40 is not "0%", it is "somewhere under 9%".
 */
export function interval(k: number, n: number): Interval {
  if (n <= 0) return { rate: 0, low: 0, high: 1, n: 0, k: 0 }

  const rate = k / n
  const denominator = 1 + (Z * Z) / n
  const centre = (rate + (Z * Z) / (2 * n)) / denominator
  const spread = (Z / denominator) * Math.sqrt((rate * (1 - rate)) / n + (Z * Z) / (4 * n * n))

  return {
    rate,
    low: Math.max(0, centre - spread),
    high: Math.min(1, centre + spread),
    n,
    k,
  }
}

/**
 * Whether two rates are actually different, or just look it.
 *
 * Non-overlapping intervals is the conservative reading — it is slightly
 * stricter than a formal two-proportion test, which is the right direction to
 * err when the cost of a false winner is rewriting a letter that was fine.
 *
 * It will refuse most of the time. That is the correct behaviour and the whole
 * point of the module.
 */
export function separates(a: Interval, b: Interval) {
  return a.low > b.high || b.low > a.high
}

/** The better of two, but only when the data supports saying so. */
export function winner(a: Interval, b: Interval): Interval | null {
  if (!separates(a, b)) return null
  return a.rate > b.rate ? a : b
}

/**
 * Roughly how many more of each it would take to settle the question.
 *
 * Turns "too early to tell" into a plan. The standard two-proportion sample
 * size, using the rates observed so far as the estimate — so it sharpens as
 * the evidence comes in, and says so rather than pretending to a precision it
 * does not have.
 *
 * Null when the observed rates are identical: no amount of data separates two
 * things that are the same.
 */
export function sendsNeeded(a: Interval, b: Interval): number | null {
  const gap = Math.abs(a.rate - b.rate)
  if (gap < 1e-9) return null

  const mean = (a.rate + b.rate) / 2
  // 80% power at 95% confidence: (z_{α/2} + z_β)² ≈ (1.96 + 0.84)² ≈ 7.85.
  const perArm = Math.ceil((7.85 * 2 * mean * (1 - mean)) / (gap * gap))
  return Math.max(perArm - Math.min(a.n, b.n), 0)
}

/**
 * A rate as a person should read it.
 *
 * "2.5%" from one click in forty is a lie of precision. "0.4–13%" is what was
 * actually measured, and reads immediately as "we do not know yet".
 */
export function readable(i: Interval, places = 1) {
  const pct = (x: number) => `${(x * 100).toFixed(places)}%`
  if (i.n === 0) return '—'
  // Once the band is tight enough, the point estimate is the honest summary.
  if (i.high - i.low < 0.02) return pct(i.rate)
  return `${pct(i.low)}–${pct(i.high)}`
}

/** How much the interval still spans, 0–1. Above ~0.5 you know almost nothing. */
export const uncertainty = (i: Interval) => i.high - i.low
