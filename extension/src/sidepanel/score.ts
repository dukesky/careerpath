/**
 * Match scores are rendered in multiples of five.
 *
 * An integer on a 0-100 scale claims a precision this instrument does not
 * have: the two numbers the panel shows come from two different model calls,
 * and the right-hand one is resampled on every regeneration. Rounding is the
 * cheapest honest response — it stops a meaningless three-point wobble from
 * reading as a real change. The cost is accepted in the other direction: a
 * small genuine improvement can round up to look like ten points.
 */
export function roundToFive(score: number): number {
  return Math.round(score / 5) * 5;
}
