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

const LIVE_RUNS_KEY = "cp_live_runs";

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
}

const STALE_ERROR = "That run stopped before it finished. Try again.";

/** Whether this state is still in flight, as opposed to idle or terminal. */
export function isRunning(state: RunState): boolean {
  return state.phase === "reading" || state.phase === "comparing" || state.phase === "writing";
}

/**
 * A corrupt or unreadable blob reads as empty rather than throwing. A cache is
 * expendable; a panel that cannot render because of one is not.
 */
async function readAll(): Promise<Record<string, LiveRun>> {
  try {
    const got = await chrome.storage.local.get([LIVE_RUNS_KEY]);
    const raw = got[LIVE_RUNS_KEY];
    if (typeof raw !== "string") return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, LiveRun>)
      : {};
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

export async function clearLiveRun(url: string): Promise<void> {
  const all = await readAll();
  delete all[cacheKey(url)];
  await chrome.storage.local.set({ [LIVE_RUNS_KEY]: JSON.stringify(all) });
}
