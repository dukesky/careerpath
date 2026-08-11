import { NextResponse } from "next/server";
import { callLLM } from "@/lib/llm";
import { normalizeResume } from "@/lib/resume";
import { normalizeJD } from "@/lib/jd";
import { buildAnalyzeMessages, normalizeGapAnalysis } from "@/lib/analysis";
import { getIdentity, hasBetaAccess } from "@/lib/identity";
import { getCaller, readRunId, unauthorized } from "@/lib/api-auth";
import { rateLimitResponse } from "@/lib/rate-limit";
import { getQuota, consumeRun } from "@/lib/quota";
import { capText, MAX_EXTRA_INFO_CHARS } from "@/lib/limits";

export const runtime = "nodejs";
export const maxDuration = 120;

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: Request) {
  const { ip } = getIdentity(request);
  const limited = await rateLimitResponse(ip);
  if (limited) return limited;

  const beta = hasBetaAccess(request);
  const resolved = await getCaller(request);
  if (!resolved.ok) return unauthorized();
  const caller = resolved.caller;

  if (!beta) {
    let quota;
    try {
      quota = await getQuota(caller, ip);
    } catch {
      // Fail closed: without a readable counter we cannot bound spend, and an
      // unbounded free window is worse than a brief outage. Contrast the
      // post-success consumeRun below, which deliberately degrades.
      return NextResponse.json(
        { error: "Usage limits are temporarily unavailable. Please try again shortly." },
        { status: 503 },
      );
    }
    if (quota.exhausted) {
      return NextResponse.json(
        { error: "You've used all your free runs.", remaining: 0 },
        { status: 402 },
      );
    }
  }

  let body: {
    structuredResume?: unknown;
    structuredJD?: unknown;
    extraInfo?: unknown;
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

  const resume = normalizeResume(body.structuredResume);
  const jd = normalizeJD(body.structuredJD);
  const extraInfo = capText(
    typeof body.extraInfo === "string" ? body.extraInfo : "",
    MAX_EXTRA_INFO_CHARS,
  );
  const quality = body.quality === "fast" ? "fast" : "quality";
  const runId = readRunId(body);

  let analysis;
  try {
    const parsed = await callLLM({
      task: "analyze",
      json: true,
      quality,
      messages: buildAnalyzeMessages(resume, jd, extraInfo),
      maxTokens: 4000,
    });
    analysis = normalizeGapAnalysis(parsed);
  } catch (err) {
    const detail = err instanceof Error ? err.message : "Unknown error";
    return bad(`Analysis failed: ${detail}`, 502);
  }

  if (beta) {
    return NextResponse.json({ analysis, remaining: null });
  }

  // A quota-store outage must not discard a completed analysis. Same posture
  // as /api/quota and llm-stats: degrade, don't block.
  try {
    const after = await consumeRun(caller, ip, runId || crypto.randomUUID());
    return NextResponse.json({ analysis, remaining: after.remaining });
  } catch {
    return NextResponse.json({ analysis, remaining: null });
  }
}
