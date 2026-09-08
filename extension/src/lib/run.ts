import type {
  GapAnalysis,
  ParsedResume,
  RequirementRow,
  TailorResult,
} from "@shared/contract";
import type { ExtractedJD } from "@/content/extract";
import { apiPost, apiStream, type ApiErrorKind, type ApiResult } from "./api";
import { compareMatrices, type Downgrade, type RescoreRow } from "./compareMatrices";
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
   * How the right-hand number above should be read, or null for "as measured".
   *
   * Set only when the rescore came back with a MATRIX to compare against the
   * analysis — an old server sends none, and an uncompared number is never
   * annotated. The three notes:
   *
   *   "maintained" — the measurement dipped below the analysis score but not
   *     one requirement got worse, so the dip is instrument noise (the same
   *     model, read twice, answers a few points apart) and `rescoredScore`
   *     carries the LEFT number rather than the lower reading.
   *   "nice_dip" — the same dip with only nice-to-have rows weaker. The number
   *     still holds at the left score; this note and `downgradedRequirements`
   *     are what stop that from being a lie.
   *   "downgraded" — a must-have got weaker and survived the repair leg. The
   *     ONLY display whose number is allowed to be lower than the left score,
   *     and the one the adoption gate is built to make vanishingly rare.
   */
  scoreNote: "maintained" | "nice_dip" | "downgraded" | null;
  /**
   * The requirements the rewrite made weaker, must-haves first.
   *
   * Non-empty exactly when `scoreNote` is "nice_dip" or "downgraded": a
   * display that holds a number up, or drops one, has to say which rows it is
   * talking about. Must-haves lead because they are the ones a reader has to
   * act on, and this is a flat list of strings — the order is the only way it
   * can distinguish them.
   */
  downgradedRequirements: string[];
  /**
   * True only while a free second tailor (tailor with the gap analysis, then a
   * second rescore) is in flight, so the panel can hint that the right-hand
   * number is still settling. Never blocks anything: the run is already `done`
   * when this goes true.
   *
   * TWO legs raise it, and they are the same free leg — never both in one run:
   * the gated auto-refine tail (RunOptions.autoRefine, off by default) and the
   * repair leg below, which fires on a dip that actually lost a requirement.
   * On the repair leg it means something stronger than a hint: no score has
   * been published yet, and the panel holds the slot on a placeholder rather
   * than showing a dipped number it is about to replace.
   */
  refining: boolean;
  /**
   * True for the whole span between the `done` paint and a settled right-hand
   * number: the first rescore, the repair leg, and the auto-refine tail.
   *
   * It exists because `rescoredScore === null` cannot tell "not measured yet"
   * apart from "measured, and it failed", and the panel owes those two states
   * completely different displays. Before this flag both rendered the tailor
   * model's own `projected_match_score` in the improvement colour with an
   * arrow, identical to a settled measurement — and a projection is the
   * rewriter grading its own work. Observed in production: "78 → 72" in green
   * for 20-30 seconds, which then became "78 → 82" when the real number
   * landed. Ten points out, in the direction that reads as "the rewrite made
   * my resume worse" — the exact perception the score floor exists to prevent,
   * arriving by a route the floor has no authority over, because the floor
   * only governs numbers something actually measured.
   *
   * So: true with nothing measured yet -> the slot holds a placeholder, false
   * + no score -> the projection, labelled as an estimate. Never a bare
   * projection. A measurement that has been published outranks the flag — the
   * placeholder's whole claim is that there is no number.
   *
   * Like `refining`, it blocks nothing — the run is already `done` when it
   * goes up, and the resume is already downloadable. Unlike `refining` it is
   * NOT part of the panel's busy gate: nothing about a measurement in flight
   * should stop the user starting another run.
   */
  measuring: boolean;
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
  scoreNote: null,
  downgradedRequirements: [],
  refining: false,
  measuring: false,
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
 * What a terminal patch says about the score note: nothing has been decided.
 *
 * Same rule as NO_STREAM, and spelled the same way for the same reason: the
 * note and the rows it names are one statement, and a patch that cleared the
 * note while leaving the names would put a previous run's lost requirements
 * under this run's number after App.tsx's state reset.
 */
const NO_SCORE_NOTE: Pick<RunState, "scoreNote" | "downgradedRequirements"> = {
  scoreNote: null,
  downgradedRequirements: [],
};

/**
 * What a terminal patch says about the measuring window: it is not open.
 *
 * Same rule as the two above, and it needs stating in the same three places
 * for a sharper reason than either of them: `measuring` is the flag that puts
 * an animated placeholder where a number goes. A terminal patch that left it
 * alone would let App.tsx's state reset carry a raised flag from a previous
 * run onto a finished or failed one, and the panel would sit forever waiting
 * on a measurement nothing is running.
 */
const NOT_MEASURING: Pick<RunState, "measuring"> = { measuring: false };

/** A rescore's answer: the number, and the matrix behind it ([] on an old server). */
interface Measurement {
  score: number;
  rows: RescoreRow[];
}

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
 * What the window definitely bounds is PUBLISHES — the storage writes and the
 * renders behind them, which is the expensive half.
 *
 * It bounds `build` less tightly than it looks. A null build means "nothing
 * new to say" and deliberately does not consume the window, so while a long
 * string is still streaming — the tailored summary, say, where every delta
 * lands mid-value and extraction keeps refusing to read it — the full-buffer
 * re-scan does run per delta. That is accepted rather than overlooked: the
 * scan is a linear pass over tens of KB at the very most, deltas arrive at
 * model speed rather than CPU speed, and the alternative (consuming the window
 * on a null) would delay the first real paint by up to a window for nothing.
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
   * the matrix, and the auto-refine tail is SKIPPED — a refine run IS one of
   * the runId's two free refinements, and its own rescore is one of the four
   * the runId is allowed. Fresh charged runs omit it.
   */
  priorAnalysis?: GapAnalysis;
  /**
   * True when this run is a user-triggered refinement of an existing runId.
   *
   * A refinement run is ITSELF the second free leg, so the auto-refine tail
   * must never fire on it — even when no cached analysis was available to pass
   * as `priorAnalysis`, which is why this is a separate flag rather than an
   * inference from that field. Letting the tail run here spends an extra
   * tailor and an extra rescore out of an allowance (8 legs, 4 rescores per
   * runId) that has none spare, produces a rewrite that can never be adopted,
   * and burns the free leg the user's OTHER refinement needs — so that one
   * gets charged.
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
  /**
   * The posting's frozen "before" number — the one the panel shows on the LEFT
   * of the arrow. Absent on a fresh run, which has no earlier one.
   *
   * The score floor must never display a right-hand number below it when the
   * matrix says nothing was lost. That is not the same as this run's analysis
   * score: a refine run re-analyses, the instrument answers a few points
   * apart, and the baseline deliberately does not move with it (see
   * cache.ts's `baselineScore` — re-measuring it per run is what made the
   * panel show the "before" score dropping after the user added experience).
   * So a held display built on this run's lower analysis would render as
   * "70 → 66" while asserting in words that nothing got worse.
   *
   * Read ONLY by the held branches of `decide` — "maintained" and "nice_dip".
   * A measurement at or above this run's analysis is a real reading of the
   * rewritten document and is published as measured, above or below this.
   */
  baselineScore?: number;
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
    onUpdate({
      phase: "error",
      error: { kind, message },
      ...NO_STREAM,
      ...NO_SCORE_NOTE,
      ...NOT_MEASURING,
    });
  };

  onUpdate({
    phase: "reading",
    analysis: null,
    tailored: null,
    // Cleared alongside the other results: a regenerate must not leave the
    // PREVIOUS run's rescore — or the note explaining it — on screen next to
    // this run's fresh numbers.
    rescoredScore: null,
    ...NO_SCORE_NOTE,
    refining: false,
    ...NOT_MEASURING,
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
    // 10_000 is the server's MAX_JD_CHARS (src/lib/limits.ts); it caps this
    // itself, so anything past it is only ever uploaded to be discarded.
    jdText: jd.text.slice(0, 10_000),
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
    // Same principle: no free second leg has started, so say so rather than
    // letting a reset leave a stale `true` beside a finished run. And nothing
    // has been measured yet, so there is no note to carry either.
    refining: false,
    // Down here and up again in the very next patch, deliberately. This one is
    // the terminal-completeness statement — a done patch describes a finished
    // run's flags rather than inheriting them — and the raise below is what
    // actually opens the window. Folding the two together (publishing
    // `measuring: true` from this patch) would tie first paint to the
    // measuring decision and leave a `done` patch that lies about a run whose
    // rescore never starts.
    ...NOT_MEASURING,
    ...NO_SCORE_NOTE,
    // And the same principle again for the streamed preview: both legs have
    // landed, so nothing is arriving. Leaving these set would strand a
    // half-written matrix and a contact-less resume next to the finished
    // result they were an approximation of.
    ...NO_STREAM,
    remaining: knownRemaining,
  });

  // The same ruler, applied to the rewritten resume. Everything above has
  // already been published, so from here on nothing this code does can delay
  // what the user is looking at — it can only replace the number, and (on
  // either of the free legs below) the document, with better versions of
  // themselves.
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
  // The try/catch inside `measureWithRows`, and the ones around the two free
  // legs, are that same rule against a THROW rather than a failure. `apiPost` does not
  // reject, but building the body reads into a response this module does not
  // validate, and background/runs.ts wraps runTailor in a catch that publishes
  // `phase: "error"` — so an exception escaping from here would do exactly the
  // damage the paragraph above forbids, by a route no reviewer of that catch
  // block would connect to rescoring. The resume is read with `?.` for the
  // same reason: a tailor body with no result at all must warn, not throw.
  const measureWithRows = async (resume: ParsedResume | undefined): Promise<Measurement | null> => {
    try {
      const rescored = await apiPost<{ score: number; rows?: RescoreRow[] }>(
        "/api/rescore",
        {
          structuredResume: resume,
          // The same JD the other two legs measured against, in the only form
          // this run has now that nothing parses it — and cut at the same
          // 10_000 (the server's MAX_JD_CHARS, src/lib/limits.ts), because
          // measuring the rewrite against a differently-shaped JD would break
          // the one property this leg exists for: the same ruler on both
          // sides of the arrow.
          jdText: jd.text.slice(0, 10_000),
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
      return {
        score: rescored.data.score,
        // The same unchecked-cast defence, and the hinge of everything below:
        // a server that predates the widened rescore response sends no rows,
        // and an empty array is the signal `decide` reads as "do not compare".
        // Comparing against an absent matrix would read every met requirement
        // as vanished and turn every run into a "downgraded" display, which is
        // why this coercion — not a `!` — is what makes the deploy order safe.
        rows: Array.isArray(rescored.data.rows) ? rescored.data.rows : [],
      };
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

  /**
   * The free second tailor, and the measurement of what it wrote.
   *
   * Buffered, deliberately. Nothing renders this leg's tokens: the panel is
   * already showing a completed run plus a hint that a better version may
   * replace it, so streaming here would put a second live preview over a
   * finished result to no one's benefit. Same runId, so the server treats it
   * as a refinement and does not charge for it.
   *
   * It publishes nothing and adopts nothing. BOTH callers below — the gated
   * auto-refine tail and the repair leg — are the same free leg spent under
   * different rules, and the rules are the whole difference between them, so
   * they stay at the call sites where they can be read against each other.
   * Null means the leg produced no rewrite at all; a non-null result with a
   * null `measurement` means it produced one nobody could measure.
   */
  const runRefineLeg = async (
    analysis: GapAnalysis,
  ): Promise<{
    tailored: TailorResult;
    measurement: Measurement | null;
    remaining: number | null;
  } | null> => {
    const refined = await apiPost<{ tailored: TailorResult; remaining: number | null }>(
      "/api/tailor",
      { ...payload, analysis },
      opts.runToken,
    );
    if (!refined.ok || !refined.data.tailored) {
      console.warn(JSON.stringify({ evt: "refine_failed" }));
      return null;
    }
    return {
      tailored: refined.data.tailored,
      measurement: await measureWithRows(refined.data.tailored.resume),
      remaining: refined.data.remaining,
    };
  };

  /**
   * A free leg's own quota read, min-ed into the count already on screen.
   *
   * The read normally REPEATS the count the done patch published — but it is
   * also the freshest read there is, and a charge committing after the done
   * patch's reads (or a run started elsewhere) leaves that count one too high.
   * Min-ed rather than assigned, for the same reason the done patch mins its
   * two reads: the number the user is watching must never jump back up. A null
   * read means "not reported", so it changes nothing.
   */
  const freshRemaining = (reported: number | null): Partial<RunState> =>
    reported === null
      ? {}
      : {
          remaining:
            knownRemaining === null ? reported : Math.min(knownRemaining, reported),
        };

  /**
   * The number the analysis put on the LEFT of the arrow, or null when this
   * run has none to compare against. Everything below is relative to it.
   */
  const leftScore =
    typeof analyzed.data.analysis?.overall_match_score === "number"
      ? analyzed.data.analysis.overall_match_score
      : null;

  /**
   * What a HELD number is held at: the higher of this run's analysis score and
   * the posting's frozen baseline (see RunOptions.baselineScore).
   *
   * Only the two "nothing a must-have cared about was lost" displays use it.
   * They are claims about the DOCUMENT, not readings of it — "this rewrite did
   * not cost you anything" — and the number under such a claim must not be
   * lower than the "before" number the same panel is showing, or the display
   * contradicts itself. A measurement is never lifted this way: an actual
   * reading of the rewritten resume is published exactly as measured.
   */
  const heldScore = (left: number) => Math.max(opts.baselineScore ?? -Infinity, left);

  /**
   * One measurement in, one display out — plus the downgrades behind it, which
   * are what the caller reads to decide whether the repair leg is worth firing.
   *
   * Three displays, in the order they are tried:
   *
   *   1. No rows to compare (an old server, or a matrix-less reply): the
   *      measurement, published exactly as this module has always published
   *      it. This branch is FIRST on purpose. It is the backward-compatibility
   *      guard, and every line under it assumes a matrix that really arrived.
   *   2. Measured at or above the left score: the measurement, annotated as
   *      needing no explanation.
   *   3. A dip. Now the matrix decides. Nothing worse -> the dip is instrument
   *      noise (the same model reads the same document a few points apart) and
   *      the LEFT score is what the panel shows. Only nice-to-haves worse ->
   *      the left score still stands, with the note and the named rows to keep
   *      it honest. A must-have worse -> the measured number, lower, named and
   *      noted: the one display this product allows to go down.
   *
   * Called on the repaired measurement too, which is why it never fires the
   * repair itself: it decides, the caller spends.
   */
  const decide = (m: Measurement): { patch: Partial<RunState>; downs: Downgrade[] } => {
    if (m.rows.length === 0) return { patch: { rescoredScore: m.score }, downs: [] };
    if (leftScore === null || m.score >= leftScore) {
      // OBSERVABILITY ONLY, and deliberately not a branch: a number that went
      // UP while the matrix says a must-have got weaker is the one shape this
      // whole design does not have an answer for — either the rewrite really
      // did lose something the score is hiding, or the two reads of the same
      // document disagree about a row. It is logged so the rate can be
      // measured before anyone decides what it should DO. Nothing below reads
      // this; the display and the leg budget are exactly what they were.
      if (leftScore !== null) {
        const up = compareMatrices(
          analyzed.data.analysis?.requirements_matrix ?? [],
          m.rows,
        ).filter((d) => d.kind === "must_have");
        if (up.length > 0) {
          console.warn(
            JSON.stringify({
              evt: "score_up_must_down",
              left: leftScore,
              measured: m.score,
              rows: up.map((d) => d.requirement),
            }),
          );
        }
      }
      return { patch: { rescoredScore: m.score, ...NO_SCORE_NOTE }, downs: [] };
    }

    const downs = compareMatrices(analyzed.data.analysis?.requirements_matrix ?? [], m.rows);
    if (downs.length === 0) {
      return {
        patch: {
          rescoredScore: heldScore(leftScore),
          scoreNote: "maintained",
          downgradedRequirements: [],
        },
        downs,
      };
    }

    const mustHave = downs.filter((d) => d.kind === "must_have");
    // Must-haves first: `downgradedRequirements` is a flat list of strings, so
    // order is the only way it can tell the panel which name matters most.
    const named = [...mustHave, ...downs.filter((d) => d.kind !== "must_have")].map(
      (d) => d.requirement,
    );
    return {
      patch:
        mustHave.length > 0
          ? { rescoredScore: m.score, scoreNote: "downgraded", downgradedRequirements: named }
          : {
              rescoredScore: heldScore(leftScore),
              scoreNote: "nice_dip",
              downgradedRequirements: named,
            },
      downs,
    };
  };

  // The measuring window opens HERE, one patch after first paint and one line
  // before the request it describes. Until it closes, the panel shows a
  // placeholder in the right-hand slot rather than
  // `tailored.projected_match_score` — see RunState.measuring for the
  // production display this replaced.
  onUpdate({ measuring: true });

  /**
   * The window's last patch, HELD rather than published as it is decided.
   *
   * Everything below decides the right-hand number and then hands it to this
   * variable; the `finally` at the bottom — or `flushClosing`, on the one path
   * that needs the number earlier — publishes it together with the closing
   * `measuring: false`. One patch, not two, and that is a
   * requirement rather than a tidiness preference: the number and the flag
   * that says whether it is a measurement are one statement, and a panel that
   * received them separately would render a frame in between — the placeholder
   * gone, the flag still up, or (worse, in the other order) the projection
   * labelled as an estimate for one frame before the real number lands.
   *
   * Empty is a complete answer. It means nothing was decided — the measurement
   * failed — and the closing patch then says only that the window is shut,
   * which is exactly what the panel needs to fall back to a LABELLED
   * projection.
   */
  let closing: Partial<RunState> = {};
  /**
   * Publish the held patch now — WITH the closing `measuring: false` — and
   * hand the closing slot to the leg that follows.
   *
   * Only the auto-refine tail needs this: it runs for tens of seconds with a
   * hint that says it is improving a number, so that number has to be on
   * screen before it starts. The flag has to come down with it, which is why
   * the flush publishes the same pair the `finally` does rather than the
   * number alone: `measuring` left up would hold the panel's right-hand slot
   * on the placeholder for the tail's whole 40-60s, covering the very number
   * this flush exists to show, underneath a sentence about it. From here on
   * the display belongs to `refining`.
   *
   * The `finally` at the bottom republishes `measuring: false` afterwards.
   * That is harmless — it is already false — and it is still what closes the
   * window on every path that never reaches this flush.
   */
  const flushClosing = () => {
    if (Object.keys(closing).length > 0) onUpdate({ ...closing, ...NOT_MEASURING });
    closing = {};
  };

  try {
    const measured = await measureWithRows(tailored.data.tailored?.resume);
    /**
     * True once the repair leg has run — which is also true of the free leg it
     * spent, so the gated auto-refine tail below must not run as well.
     */
    let repaired = false;
    if (measured) {
      const first = decide(measured);
      // ANY downgrade under a dipped number buys ONE matrix-aimed rewrite. Not
      // just a must-have: the owner widened this deliberately, because a
      // nice-to-have the rewrite dropped is still something the user had and
      // lost, and the wait costs a free leg on the ~5-8% of runs that reach here.
      //
      // Not on a refine run, though, for exactly the reason the auto-refine tail
      // is not: the server's budget for one runId funds ONE repair, and it is
      // this one. The window is 8 legs (src/lib/quota.ts's MAX_FREE_LEGS) and 4
      // rescores (the rescore route's MAX_RESCORES_PER_RUN), which pays for the
      // charged generate's pair, one repair tailor, and both free refine pairs —
      // 7 legs, 4 rescores, nothing spare. A refine that repaired itself would
      // take the leg and the rescore the user's OTHER refine is holding, and at
      // the ceiling would simply be refused. The DISPLAY still tells the truth
      // there — only the repair is skipped.
      if (first.downs.length === 0 || opts.priorAnalysis || opts.isRefinement) {
        // Phase stays "done" — it already was, and re-sending it would be the
        // only way this patch could disturb anything.
        //
        // Held rather than published, so it can ride the closing
        // `measuring: false`. Nothing is delayed by that: in every case but the
        // gated auto-refine tail — which flushes it before it starts — this is
        // already the run's last patch.
        closing = first.patch;
      } else {
        repaired = true;
        // Nothing about the score is published until the decision is final. The
        // panel holds the slot on a placeholder while `refining` is true and no
        // note has been decided, so publishing the dipped measurement here would
        // make the number visibly fall and then jump back — the exact flicker
        // the hold-the-number design exists to prevent.
        //
        // `settled` starts as the display for the measurement we already have:
        // it is what the panel gets if the repair produces nothing better, or
        // throws.
        let settled = first.patch;
        let adopted: Partial<RunState> = {};
        try {
          onUpdate({ refining: true });
          const outcome = await runRefineLeg(analyzed.data.analysis);
          const remeasured = outcome?.measurement ?? null;
          // A stricter gate than the auto-refine tail's, because this rewrite
          // exists to fix a specific regression: not-worse on the number is not
          // enough, it must also have stopped losing must-haves. A repaired
          // rewrite that still drops one is no improvement on the one the user
          // already has, and adopting it would swap the document for nothing.
          //
          // This compareMatrices call must NOT be collapsed into the `downs`
          // that `decide(remeasured)` computes just below, tempting as the
          // second comparison of the same two matrices looks. `decide` returns
          // `downs: []` from its first two branches WITHOUT comparing anything —
          // rows absent (an old server) and score-at-or-above-left both answer
          // "no downgrades" by construction. Reading those as the gate would let
          // exactly the two shapes that were never examined pass it: a rewrite
          // measured with no matrix at all, and one whose number came back up
          // while a must-have got weaker. The gate has to ask the question
          // itself.
          if (
            outcome &&
            remeasured &&
            remeasured.score >= measured.score &&
            compareMatrices(
              analyzed.data.analysis?.requirements_matrix ?? [],
              remeasured.rows,
            ).filter((d) => d.kind === "must_have").length === 0
          ) {
            // Re-branch on the measurement that now stands. `decide` can report
            // downgrades again — a nice-to-have residual — and this time they
            // are the DISPLAY, not a trigger: the repair runs once. A loop here
            // would spend free legs the runId does not have on a rewrite the
            // gate above has already refused once.
            settled = decide(remeasured).patch;
            adopted = { tailored: outcome.tailored, ...freshRemaining(outcome.remaining) };
          }
        } catch (err) {
          console.warn(
            JSON.stringify({
              evt: "repair_threw",
              message: err instanceof Error ? err.message : String(err),
            }),
          );
        } finally {
          // One patch, describing the outcome completely — the same reason the
          // done patch re-sends the analysis. Unconditional, because every path
          // out of the block above has to clear the hint it turned on, and every
          // path out of it also owes the panel a number: `settled` is the
          // pre-repair display until something better replaces it.
          //
          // Handed to `closing` rather than published, for the reason spelled
          // out there: the repair leg is inside the measuring window, so its
          // outcome and the window closing are one patch.
          closing = { ...settled, ...adopted, refining: false };
        }
      }
    }

    // The free auto-refine leg: tailor again WITH the gap analysis (same runId,
    // so the server treats it as a refinement and does not charge), measure the
    // rewrite, and adopt it only when it is not worse. A refine run skips this —
    // it IS one of the runId's two free refinements, and the allowance behind
    // them has nothing spare. `isRefinement` is checked as well as
    // `priorAnalysis` because a
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
    // one of the runId's free refinements (which silently makes the user's own
    // next refine a charged run) and doubles per-IP quota use. The two guards
    // are independent and both stay: the flag decides whether this leg exists at
    // all, `priorAnalysis || isRefinement` decides that it must never fire on a
    // run that IS itself one of those refinements.
    if (opts.autoRefine !== true) return;
    if (opts.priorAnalysis || opts.isRefinement) return;
    // Third guard, and the one that is new: the repair leg above already spent
    // the ONE repair the runId's budget funds (8 legs, 4 rescores — see the
    // repair's own comment above), on the same rewrite this tail would ask for.
    // Running both would send an extra tailor and an extra rescore out of the
    // allowance the user's two refines are holding, for a document the repair
    // has already produced, measured, and either adopted or refused.
    if (repaired) return;
    // The tail is the one leg that runs with a number already on screen — its
    // hint says it is improving that number — so the first measurement's display
    // is published NOW rather than held to the end, and the measuring window
    // closes with it: `refining` owns the slot from here. Everything after this
    // point decides the closing patch instead.
    flushClosing();
    // Adoption is published together with the closing `refining: false` rather
    // than in its own patch, so the leg ends in ONE terminal patch that
    // describes its outcome completely — the same reason the `done` patch
    // re-sends the analysis.
    let adopted: Partial<RunState> = {};
    try {
      onUpdate({ refining: true });
      const outcome = await runRefineLeg(analyzed.data.analysis);
      if (!outcome) return;
      // Adopt only a measured, not-worse rewrite: the right-hand number must
      // never go DOWN because of a leg the user did not ask for. `?? -1` adopts
      // when the first measurement itself failed — any measured number beats an
      // unmeasured projection. Unchanged from the day this leg was written; the
      // repair leg's stricter gate is its own, and deliberately not shared.
      if (outcome.measurement && outcome.measurement.score >= (measured?.score ?? -1)) {
        adopted = {
          tailored: outcome.tailored,
          // The same three-way display the first measurement got. NO_SCORE_NOTE
          // leads so that a rewrite measured WITHOUT rows cannot leave the first
          // measurement's note standing beside its new number.
          ...NO_SCORE_NOTE,
          ...decide(outcome.measurement).patch,
          ...freshRemaining(outcome.remaining),
        };
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
      //
      // Handed to `closing` rather than published: this leg is the last thing
      // inside the measuring window, so its outcome and the window closing are
      // the same patch. The outer `finally` publishes it on every path,
      // including the `return` two lines up.
      closing = { ...adopted, refining: false };
    }
  } finally {
    // The window closes exactly once, on EVERY path out of the block above:
    // the measurement that succeeded, the one that failed, either free leg,
    // one of the three early returns, or an exception on its way to
    // background/runs.ts. A `measuring` left raised is not a cosmetic leak —
    // it freezes the right-hand slot on an animated placeholder for a
    // measurement nothing is running, which is a worse display than the
    // unlabelled projection this whole flag exists to remove.
    //
    // `closing` rides along rather than arriving as its own patch; see its
    // declaration for why the number and the flag have to land together.
    onUpdate({ ...closing, ...NOT_MEASURING });
  }
}
