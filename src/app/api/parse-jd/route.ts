import { NextResponse } from "next/server";
import { callLLM } from "@/lib/llm";
import { buildJdParseMessages, normalizeJD } from "@/lib/jd";

export const runtime = "nodejs";
export const maxDuration = 60;

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: Request) {
  let text: string;
  try {
    const body = (await request.json()) as { text?: unknown };
    text = typeof body.text === "string" ? body.text.trim() : "";
  } catch {
    return bad("Invalid request body.");
  }

  if (text.length < 30) {
    return bad("Not enough job-description text to parse.", 422);
  }

  try {
    const parsed = await callLLM({
      task: "parse",
      json: true,
      messages: buildJdParseMessages(text),
      maxTokens: 2000,
    });
    return NextResponse.json({ jd: normalizeJD(parsed) });
  } catch (err) {
    const detail = err instanceof Error ? err.message : "Unknown error";
    return bad(`Failed to parse the job description: ${detail}`, 502);
  }
}
