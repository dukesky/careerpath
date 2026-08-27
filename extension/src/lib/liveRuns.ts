import { cacheKey } from "./cache";
import type { RunState } from "./run";

/**
 * Runs currently in flight, keyed per posting in chrome.storage.local.
 *
 * The sibling of cache.ts: that module stores FINISHED results under
 * `cp_results`, this one stores IN-FLIGHT runs under `cp_live_runs`. Both key
 * on cacheKey(url), and they must keep agreeing on that — a live run and the
 * cached result it becomes have to be reachable by the same key or a finished
 * run looks like it belongs to a different posting.
 *
 * Storage is the channel deliberately, rather than a runtime message port.
 * The panel can be destroyed at any moment; storage outlives it, so a newly
 * opened panel reads current state with no handshake, and chrome.storage
 * .onChanged broadcasts progress to every open panel for free.
 */

/**
 * Exported because the panel filters chrome.storage.onChanged on it — this is
 * the key a write to which means "a run moved", and the panel is a view of
 * that. Importing it rather than repeating the string follows the same rule
 * as storage.ts's HAS_SIGNED_IN_KEY: this repository has been bitten by
 * constants that had to agree across two files with nothing tying them
 * together, and a drifted key here fails SILENTLY — the panel simply stops
 * updating mid-run.
 */
export const LIVE_RUNS_KEY = "cp_live_runs";

/**
 * How long a run may go without a status update before a reader treats it as
 * dead. MV3 evicts an idle service worker after ~30s; an in-flight fetch
 * extends that, so a normal run (about a minute) survives — but a browser
 * restart or a crash can strand one mid-flight, and nothing would ever move
 * that record to a terminal state. Five minutes is generous against a slow
 * model call while still well short of "the user is staring at a dead
 * spinner".
 */
export const STALE_RUN_MS = 5 * 60 * 1000;

/**
 * The ceiling on simultaneous runs. Not arbitrary: the server rate-limits 30
 * requests per 60s per IP and one run costs three calls, so ten concurrent
 * runs would saturate it exactly and start failing everything, including
 * other tabs. Five costs fifteen calls and leaves headroom — and matches the
 * signed-in allowance of five runs a day, beyond which extra parallelism buys
 * a user nothing anyway.
 */
export const MAX_CONCURRENT_RUNS = 5;

export interface LiveRun {
  state: RunState;
  /** The posting's title, for debugging and for any future summary view. */
  jdTitle: string;
  /** Epoch ms of the last status update. See STALE_RUN_MS. */
  updatedAt: number;
  /**
   * Which resume this run is for — see lib/fingerprint.ts.
   *
   * The same obligation cache.ts's own `resumeFingerprint` carries, for the
   * same reason: this record is DISPLAYED, so the panel must be able to tell
   * whether what it is about to show was produced from the resume the user
   * has now. Without it, replacing a resume mid-run leaves output scored
   * against a resume that no longer exists on screen — and because a FAILED
   * run is never cleared, that is not a one-minute window but a permanent
   * one, until the next successful run for that posting.
   */
  resumeFingerprint: string;
}

const STALE_ERROR = "That run stopped before it finished. Try again.";

/** Whether this state is still in flight, as opposed to idle or terminal. */
export function isRunning(state: RunState): boolean {
  return state.phase === "reading" || state.phase === "comparing" || state.phase === "writing";
}

/**
 * Whether a parsed entry is shaped well enough to trust downstream.
 *
 * This is the reader's last line of defense, and the reader is the one
 * participant guaranteed to be alive when a worker has been evicted. Without
 * this check a malformed entry — hand-edited storage, or a future schema
 * change shipped without a migration — reaches withStaleRule's
 * isRunning(run.state), which throws on a missing/null `state` or `phase`.
 * That throw happens outside readAll's own try/catch (which only guards the
 * JSON.parse of the whole blob), so it would surface as a rejected promise
 * instead of the "corrupt data reads as absent" behavior this module
 * promises everywhere else.
 */
function isWellFormed(run: unknown): run is LiveRun {
  if (!run || typeof run !== "object") return false;
  const r = run as { state?: unknown; updatedAt?: unknown; resumeFingerprint?: unknown };
  if (typeof r.updatedAt !== "number" || !Number.isFinite(r.updatedAt)) return false;
  // Provenance, checked HERE so no reader can forget it — the same rule
  // cache.ts states for its own late-added fields, and the same intended
  // outcome: an entry written before this field existed cannot be vouched
  // for, so it reads as absent. Those entries are dead anyway (an extension
  // update restarts the worker and kills any fetch in flight), so dropping
  // them is strictly better than the alternative, which is counting a
  // phantom against the concurrency cap until the stale rule fires.
  if (typeof r.resumeFingerprint !== "string" || r.resumeFingerprint === "") return false;
  if (!r.state || typeof r.state !== "object") return false;
  return typeof (r.state as { phase?: unknown }).phase === "string";
}

/**
 * A corrupt or unreadable blob reads as empty rather than throwing. A cache is
 * expendable; a panel that cannot render because of one is not. This applies
 * both to the blob as a whole (bad JSON, wrong top-level shape) and to each
 * entry inside it (see isWellFormed) — an unreadable entry is indistinguishable
 * from an absent one, and dropping it silently is the intended degradation.
 */
async function readAll(): Promise<Record<string, LiveRun>> {
  try {
    const got = await chrome.storage.local.get([LIVE_RUNS_KEY]);
    const raw = got[LIVE_RUNS_KEY];
    if (typeof raw !== "string") return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, LiveRun> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (isWellFormed(value)) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Applied on READ, never on write, and that asymmetry is the whole design: if
 * the service worker has been evicted it cannot mark its own run failed, so
 * the only participant guaranteed to be alive is whoever is reading.
 */
function withStaleRule(run: LiveRun): LiveRun {
  if (!isRunning(run.state)) return run;
  if (Date.now() - run.updatedAt <= STALE_RUN_MS) return run;
  return {
    ...run,
    state: {
      ...run.state,
      phase: "error",
      error: { kind: "server", message: STALE_ERROR },
    },
  };
}

export async function getLiveRun(url: string): Promise<LiveRun | null> {
  const hit = (await readAll())[cacheKey(url)];
  return hit ? withStaleRule(hit) : null;
}

/** Every run, stale rule applied — this is what the concurrency cap counts. */
export async function getAllLiveRuns(): Promise<Record<string, LiveRun>> {
  const all = await readAll();
  const out: Record<string, LiveRun> = {};
  for (const [key, run] of Object.entries(all)) out[key] = withStaleRule(run);
  return out;
}

export async function putLiveRun(url: string, run: LiveRun): Promise<void> {
  const all = await readAll();
  all[cacheKey(url)] = run;
  await chrome.storage.local.set({ [LIVE_RUNS_KEY]: JSON.stringify(all) });
}

/**
 * Everything, in one write — the sibling of cache.ts's clearCachedRuns, and
 * called from the same place: "also remove my resume and saved results from
 * this browser." This key became DISPLAYABLE in the panel, which gave it that
 * promise's obligations too; a failed run left behind here carries the
 * previous session's analysis and tailored resume and would repaint on
 * returning to that posting, after the panel had said it kept nothing.
 *
 * Safe to call without stopping anything, because it is only reachable when
 * nothing is running: sign-out is disabled while any run is in flight (see
 * App.tsx's `anyRunning`). Were it not, a run's next progress write would
 * simply put its entry back.
 */
export async function clearAllLiveRuns(): Promise<void> {
  await chrome.storage.local.remove([LIVE_RUNS_KEY]);
}

export async function clearLiveRun(url: string): Promise<void> {
  const all = await readAll();
  delete all[cacheKey(url)];
  await chrome.storage.local.set({ [LIVE_RUNS_KEY]: JSON.stringify(all) });
}
