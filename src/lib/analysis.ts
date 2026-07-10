import type { ChatMessage } from "./llm";
import { normalizeResume, type ParsedResume } from "./resume";
import type { ParsedJD } from "./jd";

// ---------------------------------------------------------------------------
// Gap analysis
// ---------------------------------------------------------------------------

export type ReqStatus = "met" | "partially_met" | "missing";
export type ReqKind = "must_have" | "nice_to_have";

export interface RequirementRow {
  requirement: string;
  kind: ReqKind;
  status: ReqStatus;
  evidence: string;
  suggestion: string;
}

export interface GapItem {
  gap: string;
  mitigation: string;
}

export interface GapAnalysis {
  overall_match_score: number; // 0-100
  rationale: string;
  requirements_matrix: RequirementRow[];
  strengths: string[];
  gaps: GapItem[];
}

// ---------------------------------------------------------------------------
// Tailor result
// ---------------------------------------------------------------------------

export interface ChangeLogEntry {
  section: string;
  original: string;
  revised: string;
  reason: string;
}

export interface TailorResult {
  resume: ParsedResume;
  change_log: ChangeLogEntry[];
}

// ---------------------------------------------------------------------------
// Normalizers
// ---------------------------------------------------------------------------

function asString(v: unknown): string {
  if (typeof v === "string") return v;
  return v == null ? "" : String(v);
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(asString).filter((s) => s.trim() !== "");
  return [];
}

function clampScore(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function toStatus(v: unknown): ReqStatus {
  const s = asString(v).toLowerCase().replace(/[\s-]+/g, "_");
  if (s === "met") return "met";
  if (s === "partially_met" || s === "partial") return "partially_met";
  return "missing";
}

function toKind(v: unknown): ReqKind {
  const s = asString(v).toLowerCase().replace(/[\s-]+/g, "_");
  return s === "nice_to_have" || s === "nice" ? "nice_to_have" : "must_have";
}

export function normalizeGapAnalysis(input: unknown): GapAnalysis {
  const raw = (input ?? {}) as Record<string, unknown>;
  return {
    overall_match_score: clampScore(raw.overall_match_score),
    rationale: asString(raw.rationale),
    requirements_matrix: (Array.isArray(raw.requirements_matrix)
      ? raw.requirements_matrix
      : []
    ).map((r) => {
      const x = (r ?? {}) as Record<string, unknown>;
      return {
        requirement: asString(x.requirement),
        kind: toKind(x.kind),
        status: toStatus(x.status),
        evidence: asString(x.evidence),
        suggestion: asString(x.suggestion),
      };
    }),
    strengths: asStringArray(raw.strengths).slice(0, 5),
    gaps: (Array.isArray(raw.gaps) ? raw.gaps : []).map((g) => {
      const x = (g ?? {}) as Record<string, unknown>;
      return { gap: asString(x.gap), mitigation: asString(x.mitigation) };
    }),
  };
}

export function normalizeTailorResult(input: unknown): TailorResult {
  const raw = (input ?? {}) as Record<string, unknown>;
  return {
    resume: normalizeResume(raw.resume ?? raw),
    change_log: (Array.isArray(raw.change_log) ? raw.change_log : []).map(
      (c) => {
        const x = (c ?? {}) as Record<string, unknown>;
        return {
          section: asString(x.section),
          original: asString(x.original),
          revised: asString(x.revised),
          reason: asString(x.reason),
        };
      },
    ),
  };
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

function jsonBlock(label: string, value: unknown): string {
  return `--- ${label} ---\n${JSON.stringify(value, null, 2)}`;
}

const ANALYZE_SYSTEM = `You are a rigorous, honest technical recruiter and career coach. You compare a candidate against a specific role and produce an evidence-based gap analysis. You never flatter and never invent evidence — every claim must be grounded in the provided resume or extra info.

Output a SINGLE JSON object with EXACTLY this schema:

{
  "overall_match_score": 0,
  "rationale": "",
  "requirements_matrix": [
    { "requirement": "", "kind": "must_have", "status": "met", "evidence": "", "suggestion": "" }
  ],
  "strengths": [],
  "gaps": [ { "gap": "", "mitigation": "" } ]
}

Rules:
- "overall_match_score": integer 0-100. Calibrate honestly — missing several must-haves should score low.
- "rationale": one paragraph explaining the score.
- "requirements_matrix": one row for EACH must-have and each nice-to-have requirement in the job description.
  - "kind": "must_have" or "nice_to_have".
  - "status": "met", "partially_met", or "missing".
  - "evidence": quote or paraphrase the specific resume/extra-info fact that supports the status. If missing, say what is absent — do not fabricate.
  - "suggestion": concrete, honest advice for how to address or present this requirement.
- "strengths": the top 5 strengths (most relevant to THIS role) to emphasize.
- "gaps": the most important gaps, each with honest, realistic mitigation advice (never advise fabrication).
- Respond with ONLY the JSON object. No markdown, no code fences, no commentary.`;

export function buildAnalyzeMessages(
  resume: ParsedResume,
  jd: ParsedJD,
  extraInfo: string,
): ChatMessage[] {
  return [
    { role: "system", content: ANALYZE_SYSTEM },
    {
      role: "user",
      content: [
        "Analyze this candidate's fit for the role.",
        jsonBlock("CANDIDATE RESUME (JSON)", resume),
        jsonBlock(
          "EXTRA INFO FROM CANDIDATE (not on resume)",
          extraInfo.trim() || "(none provided)",
        ),
        jsonBlock("JOB DESCRIPTION (JSON)", jd),
      ].join("\n\n"),
    },
  ];
}

const TAILOR_SYSTEM = `You are an expert resume editor. You rewrite a candidate's resume to target a specific job, maximizing relevance while remaining strictly truthful.

ABSOLUTE, NON-NEGOTIABLE CONSTRAINT:
You may rephrase, reorder, re-emphasize, tighten wording, surface relevant keywords, and incorporate facts the candidate supplied in "extra info". You must NEVER invent or alter employers, job titles, dates, degrees, metrics, numbers, or experiences that are not present in the input. If a fact is not in the resume or extra info, it does not go in the output. Inventing anything is a critical failure.

Output a SINGLE JSON object with EXACTLY this schema:

{
  "resume": {
    "contact": { "name": "", "email": "", "phone": "", "location": "", "links": [] },
    "summary": "",
    "experience": [ { "company": "", "title": "", "dates": "", "bullets": [] } ],
    "projects": [ { "name": "", "description": "", "bullets": [] } ],
    "skills": [],
    "education": [ { "school": "", "degree": "", "dates": "" } ]
  },
  "change_log": [ { "section": "", "original": "", "revised": "", "reason": "" } ]
}

Rules for "resume":
- Keep contact, company/title/dates, and education factual and unchanged (you may reorder).
- Rewrite the summary and bullets to foreground role-relevant impact using the candidate's real facts.
- Fold in relevant "extra info" as real experience where appropriate.
- Reorder experience/skills so the most relevant items come first.

Rules for "change_log":
- One entry per meaningful change. "section" e.g. "Summary", "Experience — <Company>", "Skills".
- "original" and "revised" are short before/after snippets. "reason" ties the change to the job.
- Respond with ONLY the JSON object. No markdown, no code fences, no commentary.`;

export function buildTailorMessages(
  resume: ParsedResume,
  jd: ParsedJD,
  extraInfo: string,
  analysis?: GapAnalysis | null,
): ChatMessage[] {
  const blocks = [
    "Rewrite the resume to target this role. Obey the no-fabrication constraint.",
    jsonBlock("CANDIDATE RESUME (JSON)", resume),
    jsonBlock(
      "EXTRA INFO FROM CANDIDATE (real facts to use)",
      extraInfo.trim() || "(none provided)",
    ),
    jsonBlock("JOB DESCRIPTION (JSON)", jd),
  ];
  // Optional: fold in the gap analysis for extra guidance when available.
  // Omitting it lets tailor run in parallel with analyze.
  if (analysis) blocks.push(jsonBlock("GAP ANALYSIS (for guidance)", analysis));

  return [
    { role: "system", content: TAILOR_SYSTEM },
    { role: "user", content: blocks.join("\n\n") },
  ];
}
