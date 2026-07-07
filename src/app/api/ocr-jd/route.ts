import { NextResponse } from "next/server";
import { callLLM } from "@/lib/llm";
import { buildJdOcrMessages } from "@/lib/jd";
import { getIdentity } from "@/lib/identity";
import { rateLimitResponse } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_IMAGES = 4;
const MAX_SIZE_BYTES = 4 * 1024 * 1024; // 4MB each
const ACCEPTED_MIME = ["image/png", "image/jpeg", "image/jpg"];

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: Request) {
  const { ip } = getIdentity(request);
  const limited = await rateLimitResponse(ip);
  if (limited) return limited;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return bad("Expected a multipart/form-data request.");
  }

  const files = form
    .getAll("images")
    .filter((v): v is File => v instanceof File && v.size > 0);

  if (files.length === 0) return bad("Upload at least one screenshot.");
  if (files.length > MAX_IMAGES) {
    return bad(`Upload at most ${MAX_IMAGES} screenshots.`);
  }

  // Validate and convert each image to a data URL, preserving upload order.
  const images: string[] = [];
  for (const file of files) {
    if (!ACCEPTED_MIME.includes(file.type)) {
      return bad("Only PNG and JPG images are supported.", 415);
    }
    if (file.size > MAX_SIZE_BYTES) {
      return bad(`Each image must be under 4MB (${file.name}).`, 413);
    }
    const base64 = Buffer.from(await file.arrayBuffer()).toString("base64");
    const mime = file.type === "image/jpg" ? "image/jpeg" : file.type;
    images.push(`data:${mime};base64,${base64}`);
  }

  try {
    const text = await callLLM({
      task: "ocr",
      messages: buildJdOcrMessages(images.length),
      images,
      maxTokens: 4000,
    });
    return NextResponse.json({ text: text.trim() });
  } catch (err) {
    const detail = err instanceof Error ? err.message : "Unknown error";
    return bad(`OCR failed: ${detail}`, 502);
  }
}
