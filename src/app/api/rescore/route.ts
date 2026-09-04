import { NextResponse } from "next/server";
import { callLLM } from "@/lib/llm";
import { normalizeResume } from "@/lib/resume";
import { normalizeJD } from "@/lib/jd";
import { buildAnalyzeMessages, normalizeGapAnalysis } from "@/lib/analysis";
import { getIdentity, hasBetaAccess } from "@/lib/identity";
import { getCaller, readRunId, unauthorized } from "@/lib/api-auth";
import { rateLimitResponse } from "@/lib/rate-limit";
import { callerKey } from "@/lib/auth";
import { getKV } from "@/lib/kv";
import { RUN_TTL_SECONDS } from "@/lib/quota";

/**
 * Re-score a TAILORED resume with the exact instrument analyze uses.
 *
 * Why this route exists at all: the panel's "60 → 72 match" used to put
 * analyze's `overall_match_score` on the left and the tailor model's own
 * `projected_match_score` on the right. Those come from two calls that cannot
 * see each other, with different prompts and different jobs to do — two
 * uncalibrated rulers — so the difference between them was never a
 * measurement, and the product sells it as one. This route measures the
 * rewritten resume with the SAME ruler that produced the left-hand number, so
 * the delta means what the UI implies it means.
 *
 * That is also the constraint on every future edit here: `buildAnalyzeMessages`
 * is called verbatim, `task: "analyze"` routes to the same model, and the
 * temperature is left to `DEFAULT_TEMPERATURE.analyze` (0). A cheaper,
 * shorter, "just give me a number" prompt would save real tokens and would
 * silently destroy the only property this endpoint has. Do not introduce one.
 *
 * Billing: this leg does NOT consume quota. A generate stays one unit. What
 * that buys an abuser is a free analyze-grade LLM call, and extension code
 * ships publicly and unpacks in seconds — so the abuse surface is closed by
 * gates instead of by charging (see POST below).
 */

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * How many times one runId may be re-scored.
 *
 * Deliberately equal to quota.ts's own free-generate allowance: one charged
 * generate plus FREE_REFINES refinements, each producing exactly one rescore.
 * Reaching this bound means a client re-scored more times than it could
 * possibly have generated, which is not a shape the product produces.
 *
 * It is NOT derived from quota.ts's MAX_FREE_LEGS, on purpose: that constant
 * counts analyze/tailor LEGS (two per generate) and this one counts rescores
 * (one per generate). Importing it and dividing by two would look tidy and
 * would couple this ceiling to a constant whose units are different.
 */
const MAX_RESCORES_PER_RUN = 3;

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: Request) {
  const { ip } = getIdentity(request);

  // Abuse protection (per-IP) — applies to everyone, including beta users.
  // Same posture as analyze/tailor.
  const limited = await rateLimitResponse(ip);
  if (limited) return limited;

  const beta = hasBetaAccess(request);
  const resolved = await getCaller(request);
  // A present-but-invalid bearer never degrades to "anonymous" here any more
  // than it does on analyze: silently re-attributing a request is how the
  // panel ends up showing one identity's allowance while another is spent.
  if (!resolved.ok) return unauthorized();
  const caller = resolved.caller;

  let body: {
    structuredResume?: unknown;
    structuredJD?: unknown;
    quality?: unknown;
    runId?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return bad("Invalid request body.");
  }

  if (!body.structuredResume) return bad("Missing structuredResume.");
  if (!body.structuredJD) return bad("Missing structuredJD.");

  const runId = readRunId(body);
  // Unlike analyze/tailor, an absent runId cannot be waved through with a
  // fresh uuid: the run marker below is the ONLY thing standing between this
  // endpoint and an unmetered public LLM call, and a minted id would satisfy
  // nothing while looking like it did.
  if (!runId) return bad("Missing runId.");

  const kv = getKV();

  // ---------------------------------------------------------------- gate 1
  // The run marker. `consumeRun` writes `run:<caller>:<runId>` when a generate
  // is charged, so its presence is proof that this caller really did run this
  // generate. Re-scoring only ever serves a run that actually happened.
  //
  // READ ONLY. `kv.getCount`, never `kv.incr`. quota.ts pairs legs off this
  // counter's PARITY (see its LEGS_PER_GENERATE comment): an odd value is a
  // generate's first leg and charges, an even one is its second and does not.
  // One extra increment from here shifts that parity forever, so the next
  // refinement's free leg becomes a charged one and the user is billed twice
  // for one generate. This is the single most breakable line in the file.
  if (!beta) {
    let seen: number;
    try {
      seen = await kv.getCount(`run:${callerKey(caller)}:${runId}`);
    } catch {
      // Fail closed, exactly as analyze does for an unreadable quota counter:
      // without the marker we cannot tell a real run from a forged id, and an
      // ungated free LLM endpoint is worse than a brief outage.
      return NextResponse.json(
        { error: "Usage limits are temporarily unavailable. Please try again shortly." },
        { status: 503 },
      );
    }
    if (seen <= 0) {
      return NextResponse.json(
        { error: "Unknown run." },
        { status: 403 },
      );
    }
  }
  // Beta callers skip the marker gate because they have no marker to skip:
  // analyze and tailor both `return` before `consumeRun` when `hasBetaAccess`
  // is true (see both routes' `if (beta)` early return), so a beta generate
  // writes NOTHING under `run:`. Gating them here would 403 every beta tester
  // on every run. Verified against those routes rather than assumed — if
  // either one ever starts marking beta runs, this bypass should go with it.

  // ---------------------------------------------------------------- gate 2
  // The rescore's own ceiling, charged BEFORE the model call so concurrent
  // requests cannot all slip past a read-then-act window. It is a separate key
  // from the run marker for the reason above: this counter may be incremented
  // freely, that one may not.
  try {
    const rescores = await kv.incr(`rescore:${callerKey(caller)}:${runId}`, RUN_TTL_SECONDS);
    if (rescores > MAX_RESCORES_PER_RUN) {
      return NextResponse.json(
        { error: "This run has been re-scored too many times." },
        { status: 429 },
      );
    }
  } catch {
    return NextResponse.json(
      { error: "Usage limits are temporarily unavailable. Please try again shortly." },
      { status: 503 },
    );
  }

  const resume = normalizeResume(body.structuredResume);
  const jd = normalizeJD(body.structuredJD);
  const quality = body.quality === "fast" ? "fast" : "quality";

  let score: number;
  try {
    const parsed = await callLLM({
      task: "analyze",
      json: true,
      quality,
      // The empty extraInfo is not an oversight and must not be "fixed" by
      // threading the run's supplement through. `structuredResume` here is the
      // TAILORED resume, which has already absorbed whatever the user said was
      // missing — tailor's whole job. Re-supplying it as "experience not on the
      // resume" would present the same facts twice and score a document that
      // does not exist.
      messages: buildAnalyzeMessages(resume, jd, ""),
      // Same instrument, same ceiling: keep in lockstep with /api/analyze,
      // whose bench-measured worst case (3992 natural tokens) truncated at
      // 4000. A tailored long resume produces the same-sized matrix.
      maxTokens: 8000,
    });
    // The full matrix is computed and thrown away. Only the score is returned:
    // the panel has nowhere to put a second requirements table, and shipping
    // one now would fix a response shape nobody has designed a screen for. If
    // "remaining gaps after the rewrite" ever becomes a feature, widen this.
    score = normalizeGapAnalysis(parsed).overall_match_score;
  } catch (err) {
    const detail = err instanceof Error ? err.message : "Unknown error";
    return bad(`Rescoring failed: ${detail}`, 502);
  }

  return NextResponse.json({ score });
}
