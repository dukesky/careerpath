import mammoth from "mammoth";
import { extractText, getDocumentProxy } from "unpdf";

export type ResumeFileKind = "pdf" | "docx";

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** Determine the file kind from its name and/or MIME type. */
export function detectKind(
  filename: string,
  mime: string,
): ResumeFileKind | null {
  const name = filename.toLowerCase();
  if (name.endsWith(".pdf") || mime === "application/pdf") return "pdf";
  if (name.endsWith(".docx") || mime === DOCX_MIME) return "docx";
  return null;
}

/** Extract plain text from a PDF or DOCX buffer. */
export async function extractTextFromBuffer(
  buffer: Buffer,
  kind: ResumeFileKind,
): Promise<string> {
  if (kind === "pdf") {
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { text } = await extractText(pdf, { mergePages: true });
    const joined = Array.isArray(text) ? text.join("\n") : text;
    return joined.trim();
  }
  // docx
  const { value } = await mammoth.extractRawText({ buffer });
  return value.trim();
}
