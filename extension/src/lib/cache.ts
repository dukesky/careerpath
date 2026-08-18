import type { GapAnalysis, TailorResult } from "@shared/contract";

/**
 * Generated results, cached per posting in chrome.storage.local.
 *
 * This is the SECOND thing the extension persists on the user's machine — the
 * first is the base resume, in storage.ts. Nothing here is ever uploaded, and
 * /privacy says so in writing. If you change what this module stores, the
 * privacy page and the panel's clear control have to change with it.
 */

const RESULTS_KEY = "cp_results";

/** Postings go stale; keeping more would grow the blob without helping. */
export const MAX_CACHED_RUNS = 20;

export interface CachedRun {
  analysis: GapAnalysis;
  tailored: TailorResult;
  /** ISO 8601, when the run finished. */
  generatedAt: string;
  /** Experience the user said their resume omits. "" when they added none. */
  extraInfo: string;
  /**
   * The server-side run this result came from. Reusing it refines that run
   * for free; the server grants a bounded number of free refinements per
   * charged run. "" for entries written before this field existed — those
   * simply cost a new unit, which is the right degradation.
   */
  runId: string;
  /**
   * The analyze score from the FIRST run for this (posting, resume) pair,
   * carried forward unchanged by every later run. "Before" means what the
   * word says — it does not move because the user told us more about
   * themselves. Recomputing it per run is what made the panel show a score
   * DROPPING after the user added experience.
   */
  baselineScore: number;
  /**
   * Which resume produced this run — see lib/fingerprint.ts. An entry whose
   * fingerprint does not match the resume loaded now is treated as absent.
   */
  resumeFingerprint: string;
}

interface CacheEntry extends CachedRun {
  /** Normalized posting URL — see cacheKey. */
  key: string;
}

/**
 * What a stored entry may ACTUALLY look like. Entries predating each of these
 * fields are already in real users' browsers, so every read must treat them as
 * optional even though the type above does not.
 */
type StoredEntry = Omit<
  CacheEntry,
  "extraInfo" | "runId" | "baselineScore" | "resumeFingerprint"
> &
  Partial<
    Pick<CacheEntry, "extraInfo" | "runId" | "baselineScore" | "resumeFingerprint">
  >;

/**
 * The posting URL with tracking parameters and the fragment removed.
 *
 * Without this, the same posting reached from a search result
 * (`?utm_source=...`) and from a shared link occupies two entries, and the
 * second visit looks uncached. Hashing the page content was considered and
 * rejected: job pages carry timestamps and rotating "similar jobs" rails, so
 * the same posting hashes differently between loads and would almost never
 * hit.
 */
export function cacheKey(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    u.hash = "";
    // Snapshot the names first: deleting while iterating a live URLSearchParams
    // skips entries.
    for (const name of [...u.searchParams.keys()]) {
      if (
        name.startsWith("utm_") ||
        name === "ref" ||
        name === "source" ||
        name === "trk"
      ) {
        u.searchParams.delete(name);
      }
    }
    return u.toString();
  } catch {
    // Not a parseable URL. Cache under it verbatim rather than dropping the
    // result — an exact repeat still hits.
    return rawUrl;
  }
}

/**
 * A corrupt or unreadable blob reads as empty rather than throwing. A cache is
 * expendable; a panel that cannot render because of one is not.
 */
async function readAll(): Promise<StoredEntry[]> {
  try {
    const got = await chrome.storage.local.get([RESULTS_KEY]);
    const raw = got[RESULTS_KEY];
    if (typeof raw !== "string") return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StoredEntry[]) : [];
  } catch {
    return [];
  }
}

/**
 * A cached run for this posting, or null.
 *
 * ONE rule decides: an entry counts only if it carries provenance we can
 * check — a fingerprint and a numeric baseline — and that provenance matches
 * the resume loaded now. Everything else is treated as absent: nothing
 * displayed, no runId reused, the posting regenerates from scratch.
 *
 * No fallbacks, no special cases. One comprehensible predicate is worth more
 * than three rules that each handle a variant, and this one subsumes
 * migration: entries written before these fields existed have no fingerprint,
 * so they are discarded here. That is the intended outcome. We cannot confirm
 * which resume produced them, and not showing what we cannot vouch for is the
 * rule this whole design exists to establish.
 */
export async function getCachedRun(
  url: string,
  fingerprint: string,
): Promise<CachedRun | null> {
  const key = cacheKey(url);
  const hit = (await readAll()).find((e) => e.key === key);
  if (!hit) return null;
  // `Number.isFinite` rather than `typeof ... === "number"`: it returns false
  // for non-numbers too (no coercion), so it still catches a missing field,
  // but it also catches Infinity/-Infinity/NaN — reachable via a hand-edited
  // storage blob (JSON.parse('{"baselineScore":1e999}') is Infinity), which
  // would otherwise sail through the typeof check and make roundToFive render
  // NaN on screen.
  if (!hit.resumeFingerprint || !Number.isFinite(hit.baselineScore)) return null;
  if (hit.resumeFingerprint !== fingerprint) return null;
  return {
    analysis: hit.analysis,
    tailored: hit.tailored,
    generatedAt: hit.generatedAt,
    extraInfo: hit.extraInfo ?? "",
    runId: hit.runId ?? "",
    // Number.isFinite (unlike `typeof x === "number"`) is not a type guard —
    // it's typed `(number: unknown) => boolean`, so TS does not narrow
    // `hit.baselineScore` from `number | undefined` here even though the
    // check above already ruled out both `undefined` and non-finite values.
    baselineScore: hit.baselineScore as number,
    resumeFingerprint: hit.resumeFingerprint,
  };
}

/**
 * Newest first. Re-tailoring a posting replaces its entry rather than adding a
 * second one, so "Tailor again" cannot fill the cache with one posting.
 */
export async function putCachedRun(url: string, cached: CachedRun): Promise<void> {
  const key = cacheKey(url);
  const rest = (await readAll()).filter((e) => e.key !== key);
  const next = [{ key, ...cached }, ...rest].slice(0, MAX_CACHED_RUNS);
  await chrome.storage.local.set({ [RESULTS_KEY]: JSON.stringify(next) });
}

export async function clearCachedRuns(): Promise<void> {
  await chrome.storage.local.remove([RESULTS_KEY]);
}

export async function countCachedRuns(): Promise<number> {
  return (await readAll()).length;
}
