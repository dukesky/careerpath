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
  | { started: false; reason: "at-capacity" | "already-running" | "failed" };

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

  // Identity is NOT settled here. This worker has no Clerk session of its own
  // and no way to obtain one, so `currentAuthToken()` in this realm can only
  // ever answer "device" — which is precisely the silent downgrade this whole
  // change removed. The identity a run transacts under arrives in the message
  // (`runToken` above), minted by the panel, which is the only context that
  // can confirm a session. A refusal for an unconfirmable session therefore
  // belongs to the panel too, BEFORE it sends this message — see
  // lib/runToken.ts and the panel's `generate`. Do not add a session check
  // back here: it could not fire, and a gate that cannot fire reads to the
  // next maintainer as the protection, and invites deleting the one that is.
  //
  // An absent `runToken` is an anonymous caller and starts normally, exactly
  // as before sign-in existed. Sign-in is an upgrade, never a gate.

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

      // `runTailor` now returns several API calls AFTER it publishes `done`:
      // the rescore leg and the free auto-refine leg both run behind first
      // paint (see run.ts). That gap is safe BECAUSE of the ordering below and
      // nothing else — the panel reads the live run until `clearLiveRun`, so
      // the `rescoredScore` and adopted-rewrite patches published during that
      // gap are on screen before this code writes the cache. Invert "publish,
      // then cache, then clear" and they land on a record the panel has
      // already stopped reading.
      //
      // `latest` accumulates those patches, so the entry cached below is the
      // ADOPTED rewrite and its measured score, not the pre-refine pair.
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
          // Whatever the rescore leg managed to deliver. `runTailor` only
          // returns once that leg has settled, so by the time this line runs
          // the answer is final: a number, or null because the rescore failed
          // or the score was never measured. Null is written as absent so a
          // cached entry looks exactly like one from before this field
          // existed, and the panel's own `?? projected_match_score` fallback
          // handles both identically.
          ...(latest.rescoredScore === null ? {} : { rescoredScore: latest.rescoredScore }),
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
