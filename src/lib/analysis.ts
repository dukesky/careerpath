import type { ChatMessage } from "./llm";
import { normalizeResume, type ParsedResume } from "./resume";
import type { ParsedJD } from "./jd";

// ---------------------------------------------------------------------------
// Gap analysis & tailor result
// ---------------------------------------------------------------------------

export type {
  ReqStatus,
  ReqKind,
  RequirementRow,
  GapItem,
  GapAnalysis,
  ChangeLogEntry,
  TailorResult,
} from "@shared/contract";

import type {
  ReqStatus,
  ReqKind,
  GapAnalysis,
  TailorResult,
} from "@shared/contract";

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
    projected_match_score: clampScore(raw.projected_match_score),
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
You may rephrase, reorder, re-emphasize, tighten wording, surface relevant keywords, and incorporate facts the candidate supplied in "extra info". You must NEVER invent or alter employers, job titles, dates, degrees, certifications, metrics, numbers, tools, or experiences that are not present in the input. If a fact is not in the resume or extra info, it does not go in the output. Inventing anything is a critical failure.

THE TRACEABILITY TEST — apply it to every sentence you write:
Every factual claim in the output must trace to a specific statement in the resume or extra info that says the same thing. A rewrite may compress, reorder, or sharpen its source; it must never say MORE than the source — more scope, more seniority, more specificity, a longer duration, a named tool, or an explanation the source does not give. When a claim would fail this test, fall back to the source's own wording.

Fabrication is usually plausible embellishment, not invented employers. Each of these is a critical failure even when it sounds reasonable:
- DERIVED AGGREGATES: never do arithmetic over the resume. Do not claim "N years of X" or "including N years as <role>" unless the source states that figure outright. A title holds only for the dates the resume gives it — earlier roles are not retroactively "tech lead" or "senior".
- UPGRADED TOOLS AND LABELS: never name a tool, technology, ecosystem, or affiliation the source does not name for that same piece of work. A "spreadsheet model" is not "Excel/Python"; a personal open-source project is not "CNCF-ecosystem" unless the source says so.
- IMPORTED JOB-DESCRIPTION LANGUAGE: the job's keywords may only describe work the resume already supports. Never restate a JD responsibility as something the candidate did.
- INVENTED MECHANISMS: when the source states an outcome without the method ("cut errors from 3% to 0.1%"), do not supply the method. The "how" is a fact like any other.
- INFLATED SCOPE OR SPECIFICITY: "built X" is not "owned X end to end"; "presented the results internally" is not "presented <specific metrics> to <specific stakeholders>". A rewrite may be at most as specific as its source.

Truthful does not mean timid. The candidate's real facts, chosen well and written tightly, are the strongest version of this resume: lead with the most relevant real impact, keep concrete numbers the source gives, and cut filler. Rephrase for impact; never add.

APPROACH (do this before writing):
1. Identify the 3–5 most important THEMES from the job's must_have_requirements and keywords.
2. Then rewrite every section to foreground the candidate's REAL experience that maps to those themes: within each role reorder bullets so the most theme-relevant impact comes first and tighten wording to surface matching keywords; reorder skills so theme-relevant ones lead; if a summary is requested, center it on those themes.
3. Never fabricate to fit a theme — if the candidate genuinely lacks a must-have, leave it out (the gap belongs in the analysis, not the resume).

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
  "change_log": [ { "section": "", "original": "", "revised": "", "reason": "" } ],
  "projected_match_score": 0
}

Rules for "resume":
- Keep contact, company/title/dates, and education factual and unchanged (you may reorder).
- Rewrite bullets (and the summary, only when one is requested below) to foreground role-relevant impact using the candidate's real facts.
- Fold in relevant "extra info" as real experience where appropriate.
- Reorder experience/skills so the most relevant items come first.

Rules for "change_log":
- One entry per meaningful change. "section" e.g. "Summary", "Experience — <Company>", "Skills".
- "original" and "revised" are short before/after snippets. "reason" ties the change to the job.

Rules for "projected_match_score":
- Integer 0-100. Judge the TAILORED resume against the job's must-have and nice-to-have requirements exactly as a recruiter would score a gap analysis.
- Base it ONLY on real content now in the tailored resume — rewording can raise it by surfacing existing relevant experience, but missing hard requirements (skills/years/degrees the candidate genuinely lacks) still cap it. Do not inflate; a rephrase does not manufacture qualifications.

- Respond with ONLY the JSON object. No markdown, no code fences, no commentary.`;

export function buildTailorMessages(
  resume: ParsedResume,
  jd: ParsedJD,
  extraInfo: string,
  includeSummary: boolean,
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
    includeSummary
      ? "SUMMARY: Include a concise professional summary (2–3 lines) centered on the job's top themes, drawing only on the candidate's real experience. The summary is where fabrication most often creeps in: every claim in it must pass the traceability test — no computed year totals, no seniority spans, no role characterizations beyond the literal titles and statements in the source."
      : 'SUMMARY: Do NOT include a summary. Set the resume "summary" field to an empty string "".',
  ];
  // Optional: present on the refine legs only — the first run fires analyze
  // and tailor in parallel, so tailor cannot see the analysis there.
  if (analysis) {
    blocks.push(jsonBlock("GAP ANALYSIS (target the uplift honestly)", analysis));
    blocks.push(
      [
        "TARGETED UPLIFT (subordinate to the traceability test above — it never licenses adding a fact):",
        "For each requirements_matrix row with status \"partially_met\" or \"missing\", check whether the resume or extra info ALREADY contains supporting evidence the row's status failed to credit. If it does, rewrite that real evidence to be explicit and prominent, using the requirement's own vocabulary, so a recruiter re-reading the resume against that requirement would mark it met.",
        "If the resume and extra info genuinely contain no supporting evidence for a row, do NOT touch it — no bullet, no keyword, no summary clause. The gap stays in the analysis, not in the resume.",
      ].join("\n"),
    );
  }

  return [
    { role: "system", content: TAILOR_SYSTEM },
    { role: "user", content: blocks.join("\n\n") },
  ];
}
