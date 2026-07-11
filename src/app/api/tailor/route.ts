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

  // Abuse protection (per-IP) — applies to everyone, including beta users.
  const limited = await rateLimitResponse(identity.ip);
  if (limited) return limited;

  // Beta testers with a valid access code bypass the business quota entirely.
  const beta = hasBetaAccess(request);

  // Business quota — block before doing any expensive work.
  if (!beta) {
    const quota = await getQuota(identity);
    if (quota.exhausted) {
      return NextResponse.json(
        { error: "You've used all your free tailors.", remaining: 0 },
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

  let tailored;
  try {
    const parsed = await callLLM({
      task: "tailor",
      json: true,
      quality,
      messages: buildTailorMessages(resume, jd, extraInfo, analysis),
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

  // Only consume quota on a successful run.
  const after = await consumeQuota(identity);
  return NextResponse.json({ tailored, remaining: after.remaining });
}
