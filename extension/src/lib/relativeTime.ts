/**
 * "2 minutes ago" for the panel's `generated <relative time>` line.
 *
 * `now` is a parameter rather than a `Date.now()` call inside so the tests can
 * pin it. The panel does not re-render on a timer: this string is computed
 * when a result is painted, which is when the user is actually looking at it.
 */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "recently";

  const secs = Math.floor((now - then) / 1000);
  // Negative means the stored timestamp is ahead of this clock. Show the
  // floor rather than a negative count.
  if (secs < 60) return "just now";

  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;

  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;

  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
