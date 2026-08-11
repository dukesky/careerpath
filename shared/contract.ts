/**
 * Wire-format types shared by the Next.js app and the Chrome extension.
 *
 * TYPES ONLY — this module must never gain a runtime export. The extension
 * imports it with `import type`, so anything with a runtime value here would
 * silently end up in the extension bundle.
 *
 * Prompts, normalizers, and model routing stay in src/lib/.
 */

// --- Resume (source of truth was src/lib/resume.ts) -----------------------

export interface Contact {
  name: string;
  email: string;
  phone: string;
  location: string;
  links: string[];
}

export interface ExperienceEntry {
  company: string;
  title: string;
  dates: string;
  bullets: string[];
}

export interface ProjectEntry {
  name: string;
  description: string;
  bullets: string[];
}

export interface EducationEntry {
  school: string;
  degree: string;
  dates: string;
}

export interface ParsedResume {
  contact: Contact;
  summary: string;
  experience: ExperienceEntry[];
  projects: ProjectEntry[];
  skills: string[];
  education: EducationEntry[];
}

// --- Job description (source of truth was src/lib/jd.ts) ------------------

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

// --- Analysis & tailoring (source of truth was src/lib/analysis.ts) -------

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

export interface ChangeLogEntry {
  section: string;
  original: string;
  revised: string;
  reason: string;
}

export interface TailorResult {
  resume: ParsedResume;
  change_log: ChangeLogEntry[];
  /** The tailor model's estimate of how well the REWRITTEN resume now matches. */
  projected_match_score: number;
}
