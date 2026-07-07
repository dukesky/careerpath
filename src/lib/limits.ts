// Server-side input caps (defensive cost/abuse control).
export const MAX_RESUME_CHARS = 15_000;
export const MAX_JD_CHARS = 10_000;
export const MAX_EXTRA_INFO_CHARS = 5_000;

/** Truncate text to a maximum length. */
export function capText(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}
