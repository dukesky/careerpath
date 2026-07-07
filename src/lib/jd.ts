import type { ChatMessage } from "./llm";

// ---------------------------------------------------------------------------
// Structured job-description shape (shared by API routes and the frontend)
// ---------------------------------------------------------------------------

export interface ParsedJD {
  company: string;
  role_title: string;
  must_have_requirements: string[];
  nice_to_have: string[];
  key_responsibilities: string[];
  keywords: string[];
  seniority_level: string;
  company_context_hints: string;
}

export const EMPTY_JD: ParsedJD = {
  company: "",
  role_title: "",
  must_have_requirements: [],
  nice_to_have: [],
  key_responsibilities: [],
  keywords: [],
  seniority_level: "",
  company_context_hints: "",
};

// ---------------------------------------------------------------------------
// Normalization — never trust the model to include every field.
// ---------------------------------------------------------------------------

function asString(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(asString).filter(Boolean).join("; ");
  return v == null ? "" : String(v);
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(asString).filter((s) => s.trim() !== "");
  if (typeof v === "string" && v.trim() !== "") {
    return v
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

/** Coerce arbitrary parsed JSON into a complete, safe ParsedJD. */
export function normalizeJD(input: unknown): ParsedJD {
  const raw = (input ?? {}) as Record<string, unknown>;
  return {
    company: asString(raw.company),
    role_title: asString(raw.role_title),
    must_have_requirements: asStringArray(raw.must_have_requirements),
    nice_to_have: asStringArray(raw.nice_to_have),
    key_responsibilities: asStringArray(raw.key_responsibilities),
    keywords: asStringArray(raw.keywords),
    seniority_level: asString(raw.seniority_level),
    company_context_hints: asString(raw.company_context_hints),
  };
}

// ---------------------------------------------------------------------------
// Parse prompt (raw JD text -> structured JSON)
// ---------------------------------------------------------------------------

const JD_PARSE_SYSTEM = `You extract structure from a job description. You output a single JSON object and nothing else.

Output EXACTLY this schema (use "" or [] when information is absent — never invent facts):

{
  "company": "",
  "role_title": "",
  "must_have_requirements": [],
  "nice_to_have": [],
  "key_responsibilities": [],
  "keywords": [],
  "seniority_level": "",
  "company_context_hints": ""
}

Rules:
- "must_have_requirements": hard requirements (required skills, years, degrees, must-haves).
- "nice_to_have": preferred/bonus qualifications.
- "key_responsibilities": what the person will actually do.
- "keywords": concrete ATS keywords — technologies, tools, methodologies, domain terms.
- "seniority_level": e.g. "Intern", "Junior", "Mid", "Senior", "Staff", "Lead", "Manager" (best inference, or "").
- "company_context_hints": a short free-text note on the company/team/mission/culture if discernible.
- Respond with ONLY the JSON object. No markdown, no code fences, no commentary.`;

export function buildJdParseMessages(rawText: string): ChatMessage[] {
  return [
    { role: "system", content: JD_PARSE_SYSTEM },
    {
      role: "user",
      content: `Extract the structured fields from this job description.\n\n--- JOB DESCRIPTION START ---\n${rawText}\n--- JOB DESCRIPTION END ---`,
    },
  ];
}

// ---------------------------------------------------------------------------
// OCR prompt (screenshots -> transcribed JD text). Images attach to the
// final user message by callLLM.
// ---------------------------------------------------------------------------

const JD_OCR_SYSTEM = `You are an OCR transcription engine for job-description screenshots. You transcribe text verbatim and output only that text.`;

export function buildJdOcrMessages(imageCount: number): ChatMessage[] {
  return [
    { role: "system", content: JD_OCR_SYSTEM },
    {
      role: "user",
      content: `The following ${imageCount} image(s) are ordered screenshots of a SINGLE job description. Transcribe ALL of the visible job-description text into one continuous document.

- Preserve headings, section order, and bullet structure.
- Concatenate the images in the given order — the text may continue from one image to the next; do not repeat overlapping lines.
- Do NOT summarize, translate, or add commentary. Output only the transcribed job-description text.`,
    },
  ];
}
