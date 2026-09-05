import type { GapAnalysis, ParsedJD, ParsedResume, TailorResult } from "@shared/contract";
import type { ExtractedJD } from "@/content/extract";
import { apiPost, type ApiErrorKind } from "./api";

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
   */
  refining: boolean;
  remaining: number | null;
  error: { kind: ApiErrorKind; message: string } | null;
}

export const INITIAL_RUN_STATE: RunState = {
  phase: "idle",
  analysis: null,
  tailored: null,
  rescoredScore: null,
  refining: false,
  remaining: null,
  error: null,
};

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
 * Every remaining call — /api/rescore, then the free auto-refine pair
 * (/api/tailor again with the gap analysis, and a second /api/rescore to
 * measure it) — runs AFTER the `done` patch, never before it, never merged
 * into it. The done patch is first paint for the completed result: the
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
  const fail = (kind: ApiErrorKind, message: string) =>
    onUpdate({ phase: "error", error: { kind, message } });

  onUpdate({
    phase: "reading",
    analysis: null,
    tailored: null,
    // Cleared alongside the other results: a regenerate must not leave the
    // PREVIOUS run's rescore on screen next to this run's fresh numbers.
    rescoredScore: null,
    refining: false,
    error: null,
  });

  const parsed = await apiPost<{ jd: ParsedJD }>(
    "/api/parse-jd",
    { text: jd.text },
    opts.runToken,
  );
  if (!parsed.ok) return fail(parsed.kind, parsed.message);

  const runId = opts.runId || newRunId();
  const payload = {
    structuredResume: resume,
    structuredJD: parsed.data.jd,
    extraInfo: opts.extraInfo ?? "",
    quality: "quality",
    runId,
  };

  onUpdate({ phase: "comparing" });

  const analyzeCall = apiPost<{ analysis: GapAnalysis; remaining: number | null }>(
    "/api/analyze",
    payload,
    opts.runToken,
  );
  // A refine run's rewrite is aimed at the matrix the PREVIOUS charged run
  // produced; a fresh run's first tailor has no analysis to aim at yet (it is
  // still in flight beside this call), and gets one on the auto-refine leg
  // below instead.
  const tailorCall = apiPost<{ tailored: TailorResult; remaining: number | null }>(
    "/api/tailor",
    opts.priorAnalysis ? { ...payload, analysis: opts.priorAnalysis } : payload,
    opts.runToken,
  );

  const analyzed = await analyzeCall;
  if (!analyzed.ok) {
    // tailorCall is already in flight and apiPost never rejects, so there is
    // nothing to clean up. Be aware of the consequence: if analyze fails while
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
          structuredJD: parsed.data.jd,
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
  if (opts.priorAnalysis || opts.isRefinement) return;
  // Adoption is published together with the closing `refining: false` rather
  // than in its own patch, so the leg ends in ONE terminal patch that
  // describes its outcome completely — the same reason the `done` patch
  // re-sends the analysis.
  let adopted: Partial<RunState> = {};
  try {
    onUpdate({ refining: true });
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
