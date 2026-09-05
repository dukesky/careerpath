import type {
  GapAnalysis,
  ParsedResume,
  RequirementRow,
  TailorResult,
} from "@shared/contract";
import type { ExtractedJD } from "@/content/extract";
import { apiPost, apiStream, type ApiErrorKind, type ApiResult } from "./api";
import { extractNumber, extractObjects, extractString } from "./partialJson";
import { partialExperience, partialResume, partialRows } from "./runStream";

export type RunPhase = "idle" | "reading" | "comparing" | "writing" | "done" | "error";

export interface RunState {
  phase: RunPhase;
  analysis: GapAnalysis | null;
  tailored: TailorResult | null;
  /**
   * The tailored resume measured with analyze's own instrument, or null.
   *
   * Null is the normal state for most of a run's life and is not an error: it
   * means "not measured yet", and the panel falls back to the tailor model's
   * `projected_match_score` until this lands. It stays null forever when the
   * rescore leg fails, which is a deliberate silent degradation — see the
   * bottom of runTailor.
   */
  rescoredScore: number | null;
  /**
   * True only while the free auto-refine leg (tailor with the gap analysis,
   * then a second rescore) is in flight, so the panel can hint that the
   * right-hand number is still improving. Never blocks anything: the run is
   * already `done` when this goes true.
   *
   * That leg is off by default (RunOptions.autoRefine), so in production this
   * stays false for a whole run. The field and the panel's hint are kept for
   * the gated path rather than deleted.
   */
  refining: boolean;
  /**
   * The match score the analyze stream has emitted so far, or null.
   *
   * The first three of these fields are PRESENTATION, and nothing else. They
   * are read out of a half-arrived JSON buffer, they are never cached, never
   * downloaded, never measured, and no decision in this module or the worker
   * reads them. A run that never streams a byte is a completely normal run:
   * the buffered result is the only thing that has ever been authoritative.
   *
   * All three are cleared by every terminal patch, for the same reason the
   * done patch re-sends the analysis — see the comment there.
   */
  streamingScore: number | null;
  /** The complete requirement rows the analyze stream has emitted so far. */
  streamingRows: RequirementRow[];
  /**
   * A preview of the tailored resume: the summary and the experience entries
   * the tailor stream has finished writing, in a real ParsedResume so the
   * panel can render it with the real components. The sections it does not
   * carry are "not streamed", not "the model dropped them".
   */
  streamingResume: ParsedResume | null;
  remaining: number | null;
  error: { kind: ApiErrorKind; message: string } | null;
}

export const INITIAL_RUN_STATE: RunState = {
  phase: "idle",
  analysis: null,
  tailored: null,
  rescoredScore: null,
  refining: false,
  streamingScore: null,
  streamingRows: [],
  streamingResume: null,
  remaining: null,
  error: null,
};

/**
 * What a terminal patch says about the streaming preview: nothing is arriving.
 *
 * Spelled once and spread into the done and error patches so the two cannot
 * drift — a terminal patch that cleared only two of the three would leave a
 * half-written preview beside a finished result after App.tsx's state reset.
 */
const NO_STREAM: Pick<RunState, "streamingScore" | "streamingRows" | "streamingResume"> = {
  streamingScore: null,
  streamingRows: [],
  streamingResume: null,
};

/**
 * The floor between two streaming patches, per leg.
 *
 * Every patch is a chrome.storage write in the service worker (see
 * background/runs.ts's `publish`), and a model emits tokens roughly two orders
 * of magnitude faster than storage wants to absorb writes. Half a second is
 * slow enough to be free and fast enough that the score and the matrix still
 * appear to arrive live.
 */
const STREAM_PATCH_INTERVAL_MS = 500;

/**
 * A publisher that drops everything arriving inside the window above.
 *
 * `build` runs ONLY when the window is open — extraction re-scans the whole
 * buffer, so calling it per token would be quadratic in the length of a model
 * response. Returning null means "nothing new to say", and deliberately does
 * NOT consume the window: the next delta gets to try again immediately.
 */
function throttle(
  onUpdate: (patch: Partial<RunState>) => void,
): (build: () => Partial<RunState> | null) => void {
  let lastAt = 0;
  return (build) => {
    const now = Date.now();
    if (now - lastAt < STREAM_PATCH_INTERVAL_MS) return;
    const patch = build();
    if (!patch) return;
    lastAt = now;
    onUpdate(patch);
  };
}

/**
 * One leg, streamed — with the buffered request the product shipped with as
 * its fallback.
 *
 * THE rule this function exists to enforce: streaming may only make a result
 * arrive sooner, and may NEVER decide whether a run succeeds. A stream that
 * breaks, never sends a final frame, or comes back as an error frame costs the
 * user nothing but a few seconds: the same leg is re-sent buffered, under the
 * SAME runId, which is what makes the server treat it as the same charge
 * rather than a second one.
 *
 * Exactly one retry, and only here — apiStream itself never retries, and
 * `send` inside it retries only the device-token 401 it always has.
 *
 * Two things are NOT worth that retry, and both are checked before it:
 * a failure the server MEANT, and a run that is already over. See below.
 *
 * `isLive` is what the second check reads. It is a callback rather than a
 * boolean because the answer changes WHILE this function is awaiting its
 * stream: the sibling leg is running in parallel and may end the run at any
 * point between the call and the fallback.
 */
async function streamThenBuffer<T>(
  path: string,
  body: Record<string, unknown>,
  onDelta: (chunk: string) => void,
  runToken?: string,
  isLive: () => boolean = () => true,
): Promise<ApiResult<T>> {
  const streamed = await apiStream<T>(path, { ...body, stream: true }, onDelta, runToken);
  if (streamed.ok) return streamed;
  // A refusal is not a transport failure. Re-sending it buys nothing and
  // spends another rate-limit token on a client that is already blocked.
  if (streamed.kind !== "server" && streamed.kind !== "network") return streamed;
  // Nor is a leg of a run that has already ended worth re-sending. The other
  // leg failed terminally while this stream was open, the panel has been told,
  // and nothing will ever read this result — but the server would still charge
  // for producing it. Hand back the streamed failure as-is.
  if (!isLive()) return streamed;
  console.warn(
    JSON.stringify({
      evt: "stream_fell_back",
      path,
      kind: streamed.kind,
      message: streamed.message,
    }),
  );
  // The buffered attempt's failure is the one the user is told about, if it
  // comes to that: its message is the server's finished copy ("Analysis
  // failed: …"), where a streamed error frame carries a bare detail.
  return apiPost<T>(path, body, runToken);
}

/**
 * Collision-resistant enough for a per-run key, and defined everywhere.
 *
 * Exported because the PANEL decides whether a generate is new or a
 * refinement: a fresh run mints an id here, a refinement passes back the id
 * it cached, and the server charges accordingly.
 */
export function newRunId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export interface RunOptions {
  /** Experience the user says their resume does not mention. */
  extraInfo?: string;
  /**
   * Reuse a previous run's id to refine that result for free — the server
   * grants a bounded number of free refinements per charged run. Omit to
   * start a fresh, charged run.
   */
  runId?: string;
  /**
   * The identity this run transacts under, when the caller is the service
   * worker. The worker has no Clerk session of its own; the panel mints this
   * and passes it in. Omitted in the panel, where the ambient identity is
   * already correct.
   */
  runToken?: string;
  /**
   * The previous charged run's analysis, present only on a user-triggered
   * refine run. Two effects: the tailor leg sends it so the rewrite targets
   * the matrix, and the auto-refine tail is SKIPPED — a refine run is itself
   * the second (and last) free leg, and its own rescore is the third and
   * last allowed for the runId. Fresh charged runs omit it.
   */
  priorAnalysis?: GapAnalysis;
  /**
   * True when this run is a user-triggered refinement of an existing runId.
   *
   * A refinement run is ITSELF the second free leg, so the auto-refine tail
   * must never fire on it — even when no cached analysis was available to pass
   * as `priorAnalysis`, which is why this is a separate flag rather than an
   * inference from that field. Letting the tail run here sends the runId's
   * fourth rescore (refused), produces a rewrite that can never be adopted,
   * and burns the last free leg so the NEXT refinement gets charged.
   */
  isRefinement?: boolean;
  /**
   * Run the free auto-refine leg. Default FALSE.
   *
   * When true, after the first rescore the run tailors again WITH the gap
   * analysis and adopts the rewrite only if it measures not-worse.
   *
   * Off by default because bench evidence (the appendix of
   * docs/superpowers/specs/2026-09-04-score-uplift-design.md) showed the
   * analyze instrument reads THROUGH presentation: the leg improves
   * blind-judged document quality but not the measured score — while costing
   * a free leg and doubling per-IP quota use. The elicitation path (a user
   * refine carrying real new facts) is the uplift mechanism; this leg is kept
   * behind the flag, not deleted, so the bench can still exercise it.
   */
  autoRefine?: boolean;
}

/**
 * One generate action.
 *
 * The single most important line here is that `runId` is minted ONCE and sent
 * to BOTH analyze and tailor. That is what makes the pair cost one unit of
 * quota instead of two — the server dedupes on it. Wiring it into only one of
 * the two calls looks correct in isolation and silently double-charges.
 *
 * analyze and tailor are fired in parallel: tailor does not need the analysis,
 * so total latency is max(analyze, tailor), not their sum. The panel still
 * renders analysis first because it lands first.
 *
 * Every remaining call — /api/rescore, then (only when `opts.autoRefine` is
 * on, which it is not by default) the free auto-refine pair (/api/tailor
 * again with the gap analysis, and a second /api/rescore to measure it) —
 * runs AFTER the `done` patch, never before it, never merged into it. The done patch is first paint for the completed result: the
 * download button, the change log, the score card. Latency to that paint is
 * this product's number one complaint, and each of those is an analyze-grade
 * model call worth 20-30 seconds. Moving any of them in front of the done
 * patch, or awaiting one before publishing done, would spend that entire
 * budget on a result the panel can already show an approximation of.
 */
export async function runTailor(
  jd: ExtractedJD,
  resume: ParsedResume,
  onUpdate: (patch: Partial<RunState>) => void,
  opts: RunOptions = {},
): Promise<void> {
  /**
   * False from the moment this run publishes a terminal failure.
   *
   * The two model legs stream in PARALLEL, so the leg that did not fail is
   * still open when the other one ends the run — its onDelta closure still
   * holds `onUpdate`, and background/runs.ts merges whatever it publishes into
   * the stored live run. Without this, a dead run keeps painting a preview
   * over the error (and, once App.tsx restores that entry from cache, its
   * spread can carry the stale preview onto a finished result), and the
   * orphaned leg still buys itself a buffered fallback — a second charged
   * request for a run that already ended.
   *
   * Checked in three places, all of them below: the top of each delta closure,
   * and streamThenBuffer's fallback. The `done` path does not need it — both
   * legs have landed by then, so there is nothing left to silence.
   */
  let live = true;
  const fail = (kind: ApiErrorKind, message: string) => {
    live = false;
    onUpdate({ phase: "error", error: { kind, message }, ...NO_STREAM });
  };

  onUpdate({
    phase: "reading",
    analysis: null,
    tailored: null,
    // Cleared alongside the other results: a regenerate must not leave the
    // PREVIOUS run's rescore on screen next to this run's fresh numbers.
    rescoredScore: null,
    refining: false,
    ...NO_STREAM,
    error: null,
  });

  // No parse hop. The posting text the content script already extracted goes
  // straight to both model legs, which accept it as `jdText` — that serial
  // 3-8s round trip used to sit in front of every run's first paint, and
  // nothing downstream needed its structured output that the models cannot
  // read for themselves.
  const runId = opts.runId || newRunId();
  const payload = {
    structuredResume: resume,
    jdText: jd.text,
    extraInfo: opts.extraInfo ?? "",
    quality: "quality",
    runId,
  };

  onUpdate({ phase: "comparing" });

  // --- what the two streams paint on the way to their results --------------
  //
  // Each leg accumulates its own buffer and each has its own throttle window,
  // so a chatty leg cannot starve the other. Both `build` closures only ever
  // report what CHANGED, and only commit what they reported once the patch is
  // actually published — a suppressed patch must not convince the next one
  // that its rows are already on screen.
  const publishAnalyzePaint = throttle(onUpdate);
  let analyzeBuffer = "";
  let paintedScore: number | null = null;
  let paintedRows = 0;
  const onAnalyzeDelta = (chunk: string) => {
    if (!live) return;
    analyzeBuffer += chunk;
    publishAnalyzePaint(() => {
      const patch: Partial<RunState> = {};
      // Null until the number is provably complete — partialJson refuses to
      // read `8` out of a score that is about to become 87.
      const score = extractNumber(analyzeBuffer, "overall_match_score");
      if (score !== null && score !== paintedScore) patch.streamingScore = score;
      const rows = partialRows(extractObjects(analyzeBuffer, "requirements_matrix"));
      if (rows.length > paintedRows) patch.streamingRows = rows;
      if (patch.streamingScore === undefined && patch.streamingRows === undefined) return null;
      paintedScore = score ?? paintedScore;
      paintedRows = rows.length;
      return patch;
    });
  };

  const publishTailorPaint = throttle(onUpdate);
  let tailorBuffer = "";
  let paintedSummary: string | null = null;
  let paintedEntries = 0;
  const onTailorDelta = (chunk: string) => {
    if (!live) return;
    tailorBuffer += chunk;
    publishTailorPaint(() => {
      const summary = extractString(tailorBuffer, "summary");
      const experience = partialExperience(extractObjects(tailorBuffer, "experience"));
      if (summary === paintedSummary && experience.length === paintedEntries) return null;
      paintedSummary = summary;
      paintedEntries = experience.length;
      return { streamingResume: partialResume(summary, experience) };
    });
  };

  const analyzeCall = streamThenBuffer<{ analysis: GapAnalysis; remaining: number | null }>(
    "/api/analyze",
    payload,
    onAnalyzeDelta,
    opts.runToken,
    () => live,
  );
  // A refine run's rewrite is aimed at the matrix the PREVIOUS charged run
  // produced; a fresh run's first tailor has no analysis to aim at yet (it is
  // still in flight beside this call), and does not get a second pass either
  // unless `opts.autoRefine` is on — see the gated leg below.
  const tailorCall = streamThenBuffer<{ tailored: TailorResult; remaining: number | null }>(
    "/api/tailor",
    opts.priorAnalysis ? { ...payload, analysis: opts.priorAnalysis } : payload,
    onTailorDelta,
    opts.runToken,
    () => live,
  );

  const analyzed = await analyzeCall;
  if (!analyzed.ok) {
    // tailorCall is already in flight and neither transport rejects, so there
    // is nothing to clean up. Be aware of the consequence: if analyze fails while
    // tailor succeeds, tailor's result is charged and then discarded. Known,
    // accepted, and recorded against the server plan — it needs both requests
    // to land on opposite sides of the quota boundary to happen at all.
    return fail(analyzed.kind, analyzed.message);
  }
  onUpdate({
    phase: "writing",
    analysis: analyzed.data.analysis,
    remaining: analyzed.data.remaining,
  });

  const tailored = await tailorCall;
  if (!tailored.ok) return fail(tailored.kind, tailored.message);

  // Exactly one leg charges; the other's read may land before that charge
  // commits, so it can come back one too high. Show the lower of the two so
  // the count the user sees never jumps back up. Kept in a variable because
  // the auto-refine leg below refreshes it the same defensive way.
  const knownRemaining =
    analyzed.data.remaining === null
      ? tailored.data.remaining
      : tailored.data.remaining === null
        ? analyzed.data.remaining
        : Math.min(analyzed.data.remaining, tailored.data.remaining);

  onUpdate({
    phase: "done",
    // Terminal patches describe terminal state completely rather than
    // assuming an earlier patch survived: App.tsx resets state on every JD
    // URL change, including a return to the same posting after the user
    // switches tabs mid-run. If this patch carried only `tailored`, that
    // reset would wipe the analysis a "writing" patch already delivered, and
    // Results.tsx (gated on `analysis &&`) would render nothing for a
    // completed, charged run. Re-sending it here costs nothing.
    analysis: analyzed.data.analysis,
    tailored: tailored.data.tailored,
    // Same principle: the auto-refine leg has not started, so say so rather
    // than letting a reset leave a stale `true` beside a finished run.
    refining: false,
    // And the same principle again for the streamed preview: both legs have
    // landed, so nothing is arriving. Leaving these set would strand a
    // half-written matrix and a contact-less resume next to the finished
    // result they were an approximation of.
    ...NO_STREAM,
    remaining: knownRemaining,
  });

  // The same ruler, applied to the rewritten resume. Everything above has
  // already been published, so from here on nothing this code does can delay
  // what the user is looking at — it can only replace the number, and (on the
  // auto-refine leg below) the document, with better versions of themselves.
  //
  // `payload.structuredResume` is deliberately NOT reused: the whole point is
  // to measure the TAILORED resume. Sending the original again would produce a
  // second, more expensive copy of the number already on the left.
  //
  // No phase change and no error path. A rescore that fails leaves the run
  // `done` with `rescoredScore` null, the panel keeps showing tailor's own
  // projection, and the user is told nothing — because nothing that concerns
  // them went wrong. Marking the run `error` here would throw away a
  // completed, charged result over a cosmetic refinement, and is the single
  // most tempting wrong edit in this function.
  //
  // The try/catch inside `measure`, and the one around the refine leg, are
  // that same rule against a THROW rather than a failure. `apiPost` does not
  // reject, but building the body reads into a response this module does not
  // validate, and background/runs.ts wraps runTailor in a catch that publishes
  // `phase: "error"` — so an exception escaping from here would do exactly the
  // damage the paragraph above forbids, by a route no reviewer of that catch
  // block would connect to rescoring. The resume is read with `?.` for the
  // same reason: a tailor body with no result at all must warn, not throw.
  const measure = async (resume: ParsedResume | undefined): Promise<number | null> => {
    try {
      const rescored = await apiPost<{ score: number }>(
        "/api/rescore",
        {
          structuredResume: resume,
          // The same JD the other two legs measured against, in the only form
          // this run has now that nothing parses it. Measuring the rewrite
          // against a differently-shaped JD would break the one property this
          // leg exists for: the same ruler on both sides of the arrow.
          jdText: jd.text,
          quality: "quality",
          runId,
        },
        opts.runToken,
      );
      if (!rescored.ok) {
        console.warn(
          JSON.stringify({ evt: "rescore_failed", kind: rescored.kind, message: rescored.message }),
        );
        return null;
      }
      // `apiPost` casts the body to the declared type without checking it, so a
      // 200 carrying the wrong shape would otherwise put `undefined` into
      // `rescoredScore` — a value the type says cannot be there, which then
      // renders as an empty right-hand number instead of falling back to the
      // projection. Degrade to "not measured" instead.
      if (typeof rescored.data.score !== "number") {
        console.warn(JSON.stringify({ evt: "rescore_malformed" }));
        return null;
      }
      return rescored.data.score;
    } catch (err) {
      console.warn(
        JSON.stringify({
          evt: "rescore_threw",
          message: err instanceof Error ? err.message : String(err),
        }),
      );
      return null;
    }
  };

  const firstScore = await measure(tailored.data.tailored?.resume);
  // Phase stays "done" — it already was, and re-sending it would be the only
  // way this patch could disturb anything.
  if (firstScore !== null) onUpdate({ rescoredScore: firstScore });

  // The free auto-refine leg: tailor again WITH the gap analysis (same runId,
  // so the server treats it as a refinement and does not charge), measure the
  // rewrite, and adopt it only when it is not worse. A refine run skips this —
  // it IS the second free leg, and its own rescore is the last one the runId
  // is allowed. `isRefinement` is checked as well as `priorAnalysis` because a
  // refine run whose previous entry carried no usable analysis is still a
  // refine run: gating on the analysis alone would let the tail fire there and
  // spend the runId's remaining legs on a rewrite it can never adopt.
  //
  // Same first-paint rule as above, one step further out: this leg is two more
  // model calls, and every one of them happens after the `done` patch. It can
  // only replace one number and one already-downloadable document with better
  // versions of themselves; it can never delay what the user is looking at.
  //
  // Default OFF — see RunOptions.autoRefine. The leg is opt-in because it
  // cannot reliably raise the MEASURED score, and running it unasked spends
  // the runId's second free leg (which silently makes the user's own next
  // refine a charged run) and doubles per-IP quota use. The two guards are
  // independent and both stay: the flag decides whether this leg exists at
  // all, `priorAnalysis || isRefinement` decides that it must never fire on a
  // run that IS itself the second free leg.
  if (opts.autoRefine !== true) return;
  if (opts.priorAnalysis || opts.isRefinement) return;
  // Adoption is published together with the closing `refining: false` rather
  // than in its own patch, so the leg ends in ONE terminal patch that
  // describes its outcome completely — the same reason the `done` patch
  // re-sends the analysis.
  let adopted: Partial<RunState> = {};
  try {
    onUpdate({ refining: true });
    // Buffered, deliberately. Nothing renders this leg's tokens: the panel is
    // already showing a completed run plus a hint that a better version may
    // replace it, so streaming here would put a second live preview over a
    // finished result to no one's benefit.
    const refined = await apiPost<{ tailored: TailorResult; remaining: number | null }>(
      "/api/tailor",
      { ...payload, analysis: analyzed.data.analysis },
      opts.runToken,
    );
    if (!refined.ok || !refined.data.tailored) {
      console.warn(JSON.stringify({ evt: "refine_failed" }));
      return;
    }
    const refinedScore = await measure(refined.data.tailored.resume);
    // Adopt only a measured, not-worse rewrite: the right-hand number must
    // never go DOWN because of a leg the user did not ask for. `?? -1` adopts
    // when the first measurement itself failed — any measured number beats an
    // unmeasured projection.
    if (refinedScore !== null && refinedScore >= (firstScore ?? -1)) {
      adopted = { tailored: refined.data.tailored, rescoredScore: refinedScore };
      // This leg is free, so its read normally REPEATS the count the done
      // patch published — but it is also the freshest read of the quota, and
      // a charge committing after the done patch's reads (or a run started
      // elsewhere) leaves that count one too high. Min-ed rather than
      // assigned, for the same reason the done patch mins its two reads: the
      // number the user is watching must never jump back up. A null read
      // means "not reported", so it changes nothing.
      if (refined.data.remaining !== null) {
        adopted.remaining =
          knownRemaining === null
            ? refined.data.remaining
            : Math.min(knownRemaining, refined.data.remaining);
      }
    }
  } catch (err) {
    console.warn(
      JSON.stringify({
        evt: "refine_threw",
        message: err instanceof Error ? err.message : String(err),
      }),
    );
  } finally {
    // Unconditional: every path out of the block above — adopted, discarded,
    // failed, or thrown — has to clear the hint it turned on. The
    // `priorAnalysis || isRefinement` early return above is before the `true`,
    // so it needs nothing.
    onUpdate({ ...adopted, refining: false });
  }
}
