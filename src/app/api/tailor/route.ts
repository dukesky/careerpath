import { NextResponse } from "next/server";
import { callLLM } from "@/lib/llm";
import { normalizeResume } from "@/lib/resume";
import { normalizeJD } from "@/lib/jd";
import {
  buildTailorMessages,
  normalizeGapAnalysis,
  normalizeTailorResult,
} from "@/lib/analysis";
import { getIdentity } from "@/lib/identity";
import { rateLimitResponse } from "@/lib/rate-limit";
import { getQuota, consumeQuota } from "@/lib/quota";
import { capText, MAX_EXTRA_INFO_CHARS } from "@/lib/limits";

export const runtime = "nodejs";
export const maxDuration = 120;

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: Request) {
  const identity = getIdentity(request);

  // Abuse protection (per-IP) — separate concern from the business quota.
  const limited = await rateLimitResponse(identity.ip);
  if (limited) return limited;

  // Business quota — block before doing any expensive work.
  const quota = await getQuota(identity);
  if (quota.exhausted) {
    return NextResponse.json(
      { error: "You've used all your free tailors.", remaining: 0 },
      { status: 402 },
    );
  }

  let body: {
    structuredResume?: unknown;
    structuredJD?: unknown;
    extraInfo?: unknown;
    analysis?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return bad("Invalid request body.");
  }

  if (!body.structuredResume) return bad("Missing structuredResume.");
  if (!body.structuredJD) return bad("Missing structuredJD.");
  if (!body.analysis) return bad("Missing analysis.");

  const resume = normalizeResume(body.structuredResume);
  const jd = normalizeJD(body.structuredJD);
  const analysis = normalizeGapAnalysis(body.analysis);
  const extraInfo = capText(
    typeof body.extraInfo === "string" ? body.extraInfo : "",
    MAX_EXTRA_INFO_CHARS,
  );

  let tailored;
  try {
    const parsed = await callLLM({
      task: "tailor",
      json: true,
      messages: buildTailorMessages(resume, jd, extraInfo, analysis),
      maxTokens: 8000,
    });
    tailored = normalizeTailorResult(parsed);
  } catch (err) {
    const detail = err instanceof Error ? err.message : "Unknown error";
    return bad(`Tailoring failed: ${detail}`, 502);
  }

  // Only consume quota on a successful run.
  const after = await consumeQuota(identity);
  return NextResponse.json({ tailored, remaining: after.remaining });
}
