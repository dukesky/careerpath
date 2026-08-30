/**
 * TEMPORARY DIAGNOSTIC INSTRUMENTATION — remove once the MV3 service-worker
 * lifetime question is settled. See docs/superpowers/specs for the plan this
 * belongs to.
 *
 * Why this exists rather than console.log: the question being investigated is
 * whether Chrome evicts the service worker mid-run. Attaching DevTools to a
 * service worker PREVENTS Chrome from evicting it, so any console-based
 * instrumentation cannot observe the failure it is meant to diagnose — the
 * act of watching removes the thing being watched.
 *
 * Breadcrumbs written to chrome.storage.local survive the worker's death, so
 * the trail can be read AFTER a failure, from a context that was never
 * attached while the run was live.
 *
 * Every write is fire-and-forget and swallows its own failure: diagnostics
 * must never be able to break the run they are observing.
 */

const RUN_LOG_KEY = "cp_run_log";

/** Enough to cover several runs; old entries drop off the front. */
const MAX_ENTRIES = 300;

export interface RunLogEntry {
  /** Epoch ms. The GAPS between entries are the point — that is where an
   *  evicted worker shows up as a trail that simply stops. */
  t: number;
  /** Short event name, e.g. "start", "publish", "done", "throw". */
  evt: string;
  /** Free-form context: the posting key, a phase, an error message. */
  detail?: string;
}

/**
 * Appends one breadcrumb. Never throws and never rejects — a diagnostic that
 * can fail the thing it observes is worse than no diagnostic.
 */
export async function logRun(evt: string, detail?: string): Promise<void> {
  try {
    const got = await chrome.storage.local.get([RUN_LOG_KEY]);
    const raw = got[RUN_LOG_KEY];
    const prev: RunLogEntry[] =
      typeof raw === "string" ? (JSON.parse(raw) as RunLogEntry[]) : [];
    const next = [...(Array.isArray(prev) ? prev : []), { t: Date.now(), evt, detail }].slice(
      -MAX_ENTRIES,
    );
    await chrome.storage.local.set({ [RUN_LOG_KEY]: JSON.stringify(next) });
  } catch {
    // Deliberately silent. See the module comment.
  }
}

/** Reads the trail back, oldest first. */
export async function readRunLog(): Promise<RunLogEntry[]> {
  try {
    const got = await chrome.storage.local.get([RUN_LOG_KEY]);
    const raw = got[RUN_LOG_KEY];
    if (typeof raw !== "string") return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as RunLogEntry[]) : [];
  } catch {
    return [];
  }
}

/**
 * Formats the trail as one line per entry with the gap since the previous
 * one, because the gap is what identifies an eviction: a healthy run shows
 * steady progress, an evicted one shows a trail that stops and never resumes.
 */
export async function dumpRunLog(): Promise<string> {
  const entries = await readRunLog();
  if (entries.length === 0) return "(no run log entries)";
  return entries
    .map((e, i) => {
      const gap = i === 0 ? 0 : e.t - entries[i - 1].t;
      const clock = new Date(e.t).toISOString().slice(11, 23);
      return `${clock}  +${String(gap).padStart(6)}ms  ${e.evt}${e.detail ? `  ${e.detail}` : ""}`;
    })
    .join("\n");
}

export async function clearRunLog(): Promise<void> {
  await chrome.storage.local.remove([RUN_LOG_KEY]);
}
