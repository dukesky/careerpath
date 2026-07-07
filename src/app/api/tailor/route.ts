import { NextResponse } from "next/server";
import { callLLM } from "@/lib/llm";
import { normalizeResume } from "@/lib/resume";
import { normalizeJD } from "@/lib/jd";
import {
  buildTailorMessages,
  normalizeGapAnalysis,
  normalizeTailorResult,
} from "@/lib/analysis";

export const runtime = "nodejs";
export const maxDuration = 120;

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: Request) {
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
  const extraInfo =
    typeof body.extraInfo === "string" ? body.extraInfo : "";

  try {
    const parsed = await callLLM({
      task: "tailor",
      json: true,
      messages: buildTailorMessages(resume, jd, extraInfo, analysis),
      maxTokens: 8000,
    });
    return NextResponse.json({ tailored: normalizeTailorResult(parsed) });
  } catch (err) {
    const detail = err instanceof Error ? err.message : "Unknown error";
    return bad(`Tailoring failed: ${detail}`, 502);
  }
}
