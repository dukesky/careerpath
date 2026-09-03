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
  remaining: number | null;
  error: { kind: ApiErrorKind; message: string } | null;
}

export const INITIAL_RUN_STATE: RunState = {
  phase: "idle",
  analysis: null,
  tailored: null,
  rescoredScore: null,
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
 * A fourth call, /api/rescore, runs AFTER the `done` patch — never before it,
 * never merged into it. The done patch is first paint for the completed
 * result: the download button, the change log, the score card. Latency to
 * that paint is this product's number one complaint, and the rescore is an
 * analyze-grade model call worth 20-30 seconds. Moving it in front of the
 * done patch, or awaiting it before publishing done, would spend that entire
 * budget on a number the panel can already show an approximation of.
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
  const tailorCall = apiPost<{ tailored: TailorResult; remaining: number | null }>(
    "/api/tailor",
    payload,
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
    // Exactly one leg charges; the other's read may land before that charge
    // commits, so it can come back one too high. Show the lower of the two so
    // the count the user sees never jumps back up.
    remaining:
      analyzed.data.remaining === null
        ? tailored.data.remaining
        : tailored.data.remaining === null
          ? analyzed.data.remaining
          : Math.min(analyzed.data.remaining, tailored.data.remaining),
  });

  // The same ruler, applied to the rewritten resume. Everything above has
  // already been published, so from here on nothing this code does can delay
  // what the user is looking at — it can only improve one number on it.
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
  // The try/catch is that same rule against a THROW rather than a failure.
  // `apiPost` does not reject, but building the body reads into a response
  // this module does not validate, and background/runs.ts wraps runTailor in a
  // catch that publishes `phase: "error"` — so an exception escaping from here
  // would do exactly the damage the paragraph above forbids, by a route no
  // reviewer of that catch block would connect to rescoring.
  try {
    const rescored = await apiPost<{ score: number }>(
      "/api/rescore",
      {
        structuredResume: tailored.data.tailored.resume,
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
      return;
    }
    // `apiPost` casts the body to the declared type without checking it, so a
    // 200 carrying the wrong shape would otherwise put `undefined` into
    // `rescoredScore` — a value the type says cannot be there, which then
    // renders as an empty right-hand number instead of falling back to the
    // projection. Degrade to "not measured" instead.
    if (typeof rescored.data.score !== "number") {
      console.warn(JSON.stringify({ evt: "rescore_malformed" }));
      return;
    }
    // Phase stays "done" — it already was, and re-sending it would be the only
    // way this patch could disturb anything.
    onUpdate({ rescoredScore: rescored.data.score });
  } catch (err) {
    console.warn(
      JSON.stringify({
        evt: "rescore_threw",
        message: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}
