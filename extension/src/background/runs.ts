import type { ExtractedJD } from "@/content/extract";
import type { ParsedResume } from "@shared/contract";
import { cacheKey, getCachedRun, putCachedRun } from "@/lib/cache";
import {
  MAX_CONCURRENT_RUNS,
  clearLiveRun,
  getAllLiveRuns,
  getLiveRun,
  isRunning,
  putLiveRun,
} from "@/lib/liveRuns";
import { INITIAL_RUN_STATE, newRunId, runTailor, type RunState } from "@/lib/run";
// TEMPORARY: diagnostic breadcrumbs for the service-worker lifetime question.
// Remove with lib/runLog.ts once that is settled.
import { logRun } from "@/lib/runLog";
import { currentAuthToken } from "@/lib/session";

/**
 * Runs live here, not in the panel, so that closing the panel or switching
 * tabs cannot kill one. The panel starts a run with this message and then
 * only ever READS state back out of lib/liveRuns.
 */
export interface StartRunMessage {
  type: "start-run";
  jd: ExtractedJD;
  resume: ParsedResume;
  supplement: string;
  /** Which resume this run is for — see lib/fingerprint.ts. */
  fingerprint: string;
  /**
   * The identity this run transacts under. Minted by the panel, which has a
   * working Clerk session; the worker has none of its own. Absent for an
   * anonymous caller, who runs on the device identity.
   */
  runToken?: string;
}

/**
 * `failed` is not something startRun() itself ever returns — it is what the
 * message handler answers when startRun() rejects, so the panel can tell "the
 * worker fell over" from "we refused". Without it the handler had to borrow
 * `at-capacity`, and the panel would tell a user five postings were already
 * generating when in fact nothing was.
 */
export type StartRunResult =
  | { started: true }
  | {
      started: false;
      reason: "at-capacity" | "already-running" | "failed" | "session-expired";
    };

export async function startRun(msg: StartRunMessage): Promise<StartRunResult> {
  const forUrl = cacheKey(msg.jd.url);

  const existing = await getLiveRun(forUrl);
  if (existing && isRunning(existing.state)) return { started: false, reason: "already-running" };

  const running = Object.values(await getAllLiveRuns()).filter((r) => isRunning(r.state));
  if (running.length >= MAX_CONCURRENT_RUNS) return { started: false, reason: "at-capacity" };

  // `resumeFingerprint` travels with every publish, not just the final write:
  // the panel displays these records, so each one has to say which resume it
  // was produced from — see LiveRun's own doc comment.
  const publish = (state: RunState) =>
    putLiveRun(forUrl, {
      state,
      jdTitle: msg.jd.title,
      updatedAt: Date.now(),
      resumeFingerprint: msg.fingerprint,
    });

  // Identity is settled BEFORE a run is minted, so a user whose session
  // cannot be confirmed hears about it on the click rather than after a
  // minute of watching a spinner reach an error that reads like a network
  // fault.
  //
  // Deliberately AFTER the two checks above and not before them: those are
  // local storage reads, while this one can cost a Clerk load() round trip on
  // a cold worker. Ordering it later also keeps `already-running` winning,
  // which matters — that path exists so the panel renders the existing run's
  // own progress, and a session hiccup must not replace that with an error.
  //
  // Only `session_unavailable` stops a run. A device caller and a caller with
  // no token at all both proceed: anonymous use keeps working exactly as it
  // did, and sign-in stays an upgrade rather than a gate.
  const auth = await currentAuthToken();
  if (auth?.kind === "session_unavailable") {
    // PUBLISHED, not merely returned. The panel's "Sign in again" button
    // renders off the run state (App.tsx), not off this result, so publishing
    // is the thing that puts a route back to sign-in on screen. The wording
    // matches lib/api.ts's for the same condition, so a user sees one
    // sentence for one problem however they reach it.
    await publish({
      ...INITIAL_RUN_STATE,
      phase: "error",
      error: {
        kind: "session_expired",
        message: "We couldn't confirm your session. Sign in again to continue.",
      },
    });
    return { started: false, reason: "session-expired" };
  }

  // Refining reuses this posting's run id, which is what makes it free; a
  // first run — or one after an entry too old to carry an id — mints a new
  // one and is charged.
  const prior = await getCachedRun(forUrl, msg.fingerprint);
  const runId = msg.supplement.trim().length > 0 && prior?.runId ? prior.runId : newRunId();

  await publish({ ...INITIAL_RUN_STATE, phase: "reading" });
  void logRun("start", `${forUrl} runId=${runId}`);

  // Deliberately not awaited: the caller is a message handler and must answer
  // "started" immediately. The run's own writes are what the panel watches.
  void (async () => {
    let latest: RunState = INITIAL_RUN_STATE;
    try {
      await runTailor(
        msg.jd,
        msg.resume,
        (patch) => {
          latest = { ...latest, ...patch };
          void logRun("phase", `${forUrl} ${latest.phase}`);
          // A rejection here (storage quota, or "extension context invalidated"
          // during a reload/update) must not vanish silently: without a
          // handler it would either surface as an unhandled rejection or, for
          // an error patch specifically, leave the run stuck at its last
          // published phase until the five-minute stale rule finally fires.
          void publish(latest).catch((err) =>
            console.warn("failed to publish run progress", err),
          );
        },
        { extraInfo: msg.supplement, runId, runToken: msg.runToken },
      );

      if (latest.phase === "done" && latest.analysis && latest.tailored) {
        // The baseline is READ, not re-measured. Recomputing it per run is
        // what made the panel show the "before" score dropping after a user
        // added experience — the number is meant to be what it says.
        const baseline = prior?.baselineScore ?? latest.analysis.overall_match_score;
        await putCachedRun(forUrl, {
          analysis: latest.analysis,
          tailored: latest.tailored,
          generatedAt: new Date().toISOString(),
          extraInfo: msg.supplement,
          runId,
          baselineScore: baseline,
          resumeFingerprint: msg.fingerprint,
        });
        // Success moves the record from "in flight" to "cached"; a failure
        // deliberately stays put, so returning to the posting shows the error
        // rather than a blank panel.
        await clearLiveRun(forUrl);
        void logRun("cached", forUrl);
      } else {
        void logRun("ended-not-done", `${forUrl} phase=${latest.phase}`);
      }
    } catch (err) {
      void logRun("threw", `${forUrl} ${err instanceof Error ? err.message : String(err)}`);
      // runTailor folds its own failures into RunState, so reaching here means
      // something unexpected — record it rather than leaving a run that never
      // reaches a terminal state.
      //
      // This publish is the outermost frame of an un-awaited IIFE: if it
      // itself rejects (same storage-quota / context-invalidated causes as
      // above) with no handler, that becomes an unhandled promise rejection
      // rather than a quietly stranded run.
      await publish({
        ...latest,
        phase: "error",
        error: {
          kind: "server",
          message: err instanceof Error ? err.message : "Something went wrong.",
        },
      }).catch((publishErr) => console.warn("failed to publish run failure", publishErr));
    }
  })();

  return { started: true };
}
