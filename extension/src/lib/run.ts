import type { GapAnalysis, ParsedJD, ParsedResume, TailorResult } from "@shared/contract";
import type { ExtractedJD } from "@/content/extract";
import { apiPost, type ApiErrorKind } from "./api";

export type RunPhase = "idle" | "reading" | "comparing" | "writing" | "done" | "error";

export interface RunState {
  phase: RunPhase;
  analysis: GapAnalysis | null;
  tailored: TailorResult | null;
  remaining: number | null;
  error: { kind: ApiErrorKind; message: string } | null;
}

export const INITIAL_RUN_STATE: RunState = {
  phase: "idle",
  analysis: null,
  tailored: null,
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
 */
export async function runTailor(
  jd: ExtractedJD,
  resume: ParsedResume,
  onUpdate: (patch: Partial<RunState>) => void,
  opts: RunOptions = {},
): Promise<void> {
  const fail = (kind: ApiErrorKind, message: string) =>
    onUpdate({ phase: "error", error: { kind, message } });

  onUpdate({ phase: "reading", analysis: null, tailored: null, error: null });

  const parsed = await apiPost<{ jd: ParsedJD }>("/api/parse-jd", { text: jd.text });
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
  );
  const tailorCall = apiPost<{ tailored: TailorResult; remaining: number | null }>(
    "/api/tailor",
    payload,
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
}
