import { NextResponse } from "next/server";
import { callLLM } from "@/lib/llm";
import { normalizeResume } from "@/lib/resume";
import { normalizeJD } from "@/lib/jd";
import { buildAnalyzeMessages, normalizeGapAnalysis } from "@/lib/analysis";

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
  const extraInfo =
    typeof body.extraInfo === "string" ? body.extraInfo : "";

  try {
    const parsed = await callLLM({
      task: "analyze",
      json: true,
      messages: buildAnalyzeMessages(resume, jd, extraInfo),
      maxTokens: 4000,
    });
    return NextResponse.json({ analysis: normalizeGapAnalysis(parsed) });
  } catch (err) {
    const detail = err instanceof Error ? err.message : "Unknown error";
    return bad(`Analysis failed: ${detail}`, 502);
  }
}
