import { NextResponse } from "next/server";
import { callLLM } from "@/lib/llm";
import { normalizeResume } from "@/lib/resume";
import { normalizeJD } from "@/lib/jd";
import {
  buildTailorMessages,
  normalizeGapAnalysis,
  normalizeTailorResult,
} from "@/lib/analysis";
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

  // Abuse protection (per-IP) — applies to everyone, including beta users.
  const limited = await rateLimitResponse(ip);
  if (limited) return limited;

  // Beta testers with a valid access code bypass the business quota entirely.
  const beta = hasBetaAccess(request);
  const resolved = await getCaller(request);
  if (!resolved.ok) return unauthorized();
  const caller = resolved.caller;

  // Business quota — block before doing any expensive work.
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
    analysis?: unknown;
    quality?: unknown;
    includeSummary?: unknown;
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
  // Optional — omitted when analyze runs in parallel with tailor.
  const analysis = body.analysis ? normalizeGapAnalysis(body.analysis) : null;
  const extraInfo = capText(
    typeof body.extraInfo === "string" ? body.extraInfo : "",
    MAX_EXTRA_INFO_CHARS,
  );
  const quality = body.quality === "fast" ? "fast" : "quality";
  const includeSummary = body.includeSummary !== false; // default true
  const runId = readRunId(body);

  let tailored;
  try {
    const parsed = await callLLM({
      task: "tailor",
      json: true,
      quality,
      messages: buildTailorMessages(resume, jd, extraInfo, includeSummary, analysis),
      maxTokens: 8000,
    });
    tailored = normalizeTailorResult(parsed);
  } catch (err) {
    const detail = err instanceof Error ? err.message : "Unknown error";
    return bad(`Tailoring failed: ${detail}`, 502);
  }

  // Beta users don't consume quota; report unlimited (remaining: null).
  if (beta) {
    return NextResponse.json({ tailored, remaining: null });
  }

  // A quota-store outage must not discard a completed tailor. Same posture as
  // /api/quota and llm-stats: degrade, don't block.
  try {
    const after = await consumeRun(caller, ip, runId || crypto.randomUUID());
    return NextResponse.json({ tailored, remaining: after.remaining });
  } catch {
    return NextResponse.json({ tailored, remaining: null });
  }
}
