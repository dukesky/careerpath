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
}

interface CacheEntry extends CachedRun {
  /** Normalized posting URL — see cacheKey. */
  key: string;
}

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
async function readAll(): Promise<CacheEntry[]> {
  try {
    const got = await chrome.storage.local.get([RESULTS_KEY]);
    const raw = got[RESULTS_KEY];
    if (typeof raw !== "string") return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as CacheEntry[]) : [];
  } catch {
    return [];
  }
}

export async function getCachedRun(url: string): Promise<CachedRun | null> {
  const key = cacheKey(url);
  const hit = (await readAll()).find((e) => e.key === key);
  if (!hit) return null;
  return {
    analysis: hit.analysis,
    tailored: hit.tailored,
    generatedAt: hit.generatedAt,
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
