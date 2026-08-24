import { apiGet } from "./api";

/**
 * What the panel knows about the caller's allowance right now.
 *
 * `remaining: null` means UNKNOWN, never zero. The two are rendered
 * differently and must not be conflated: an unknown count shows no number at
 * all, while zero tells the user they are out of runs. The server returns an
 * unknown count whenever its store is unreachable, which is exactly when
 * telling a user they have no runs left would be both wrong and unhelpful.
 */
export type QuotaInfo = { remaining: number | null; unlimited: boolean };

/** The subset of GET /api/quota this module reads. */
interface QuotaResponse {
  remaining?: unknown;
  unlimited?: unknown;
}

/**
 * The caller's current allowance, or `null` if it could not be determined.
 *
 * Callers MUST treat `null` as "unknown" and render no number — see the note
 * on QuotaInfo. This is a read: it costs the user nothing.
 */
export async function fetchQuota(): Promise<QuotaInfo | null> {
  const res = await apiGet<QuotaResponse>("/api/quota");
  if (!res.ok) return null;
  const { remaining, unlimited } = res.data;
  return {
    remaining:
      typeof remaining === "number" && Number.isFinite(remaining) ? remaining : null,
    unlimited: unlimited === true,
  };
}
