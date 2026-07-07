import { NextResponse } from "next/server";
import { callLLM } from "@/lib/llm";
import { detectKind, extractTextFromBuffer } from "@/lib/extract";
import { buildParseMessages, normalizeResume } from "@/lib/resume";

// unpdf/mammoth need the Node.js runtime (not edge).
export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5MB

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return bad("Expected a multipart/form-data request.");
  }

  const pastedText = form.get("text");
  const file = form.get("file");

  // Resolve raw resume text either from a pasted-text fallback or an upload.
  let rawText = "";

  if (typeof pastedText === "string" && pastedText.trim() !== "") {
    rawText = pastedText.trim();
  } else if (file instanceof File) {
    if (file.size === 0) return bad("The uploaded file is empty.");
    if (file.size > MAX_SIZE_BYTES) {
      return bad("File is larger than the 5MB limit.", 413);
    }
    const kind = detectKind(file.name, file.type);
    if (!kind) return bad("Unsupported file type. Upload a PDF or DOCX.", 415);

    const buffer = Buffer.from(await file.arrayBuffer());
    try {
      rawText = await extractTextFromBuffer(buffer, kind);
    } catch {
      return bad(
        "Could not read that file. If it is a scanned PDF, paste the resume text instead.",
        422,
      );
    }
  } else {
    return bad("Provide a resume file or pasted text.");
  }

  if (rawText.trim().length < 30) {
    return bad(
      "Not enough text was found. If this is a scanned PDF, paste the resume text instead.",
      422,
    );
  }

  // Structure the raw text into JSON via the LLM parse task.
  let resume;
  try {
    const parsed = await callLLM({
      task: "parse",
      json: true,
      messages: buildParseMessages(rawText),
      maxTokens: 4000,
    });
    resume = normalizeResume(parsed);
  } catch (err) {
    const detail = err instanceof Error ? err.message : "Unknown error";
    return bad(`Failed to parse the resume: ${detail}`, 502);
  }

  return NextResponse.json({ resume });
}
