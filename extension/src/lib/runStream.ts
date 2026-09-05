/**
 * Shapes for the half-arrived values a streaming leg paints.
 *
 * These are DISPLAY-ONLY coercions of objects pulled out of a partial JSON
 * buffer by partialJson.ts. They exist because the extension cannot reach the
 * server's normalizers: `normalizeGapAnalysis` and `normalizeResume` live in
 * the Next app's src/lib/, which the extension does not (and must not) import —
 * @shared/contract is types only, by that file's own rule. Every payload the
 * panel renders today came back from a route that already ran those
 * normalizers; a streamed prefix is the first thing it will render that did
 * not, so the coercion has to happen here.
 *
 * The semantics deliberately MIRROR the server's `toStatus` / `toKind` (see
 * src/lib/analysis.ts) rather than inventing their own, so a row painted mid-
 * stream cannot change status when the final frame replaces it with the
 * normalized one. They are intentionally narrower in one place only: a row or
 * an entry with nothing to say is dropped instead of rendered as an empty
 * card, because a half-written stream produces those and a completed response
 * does not.
 *
 * Pure: no I/O, no state. Nothing here may throw — it runs on model output
 * that is, by construction, incomplete.
 */

import type {
  ExperienceEntry,
  ParsedResume,
  ReqKind,
  ReqStatus,
  RequirementRow,
} from "@shared/contract";

function asString(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map(asString).filter((s) => s.trim() !== "") : [];
}

/** Mirrors src/lib/analysis.ts `toStatus`: anything unrecognised is a gap. */
function toStatus(v: unknown): ReqStatus {
  const s = asString(v).toLowerCase().replace(/[\s-]+/g, "_");
  if (s === "met") return "met";
  if (s === "partially_met" || s === "partial") return "partially_met";
  return "missing";
}

/** Mirrors src/lib/analysis.ts `toKind`: anything unrecognised is a must-have. */
function toKind(v: unknown): ReqKind {
  const s = asString(v).toLowerCase().replace(/[\s-]+/g, "_");
  return s === "nice_to_have" || s === "nice" ? "nice_to_have" : "must_have";
}

/**
 * The complete rows of a still-arriving requirements matrix.
 *
 * A row with no requirement text is dropped rather than painted: it is a row
 * the model wrote in an order this extraction cannot use, and a blank line in
 * the matrix reads as a bug where a missing line reads as "still writing".
 */
export function partialRows(objects: unknown[]): RequirementRow[] {
  const rows: RequirementRow[] = [];
  for (const object of objects) {
    const raw = (object ?? {}) as Record<string, unknown>;
    if (typeof raw.requirement !== "string" || !raw.requirement.trim()) continue;
    rows.push({
      requirement: raw.requirement,
      kind: toKind(raw.kind),
      status: toStatus(raw.status),
      evidence: asString(raw.evidence),
      suggestion: asString(raw.suggestion),
    });
  }
  return rows;
}

/**
 * The complete experience entries of a still-arriving tailored resume.
 *
 * Same rule as the rows: an entry that names neither a company nor a title has
 * nothing a reader could recognise, so it waits for the frame that gives it
 * one.
 */
export function partialExperience(objects: unknown[]): ExperienceEntry[] {
  const entries: ExperienceEntry[] = [];
  for (const object of objects) {
    const raw = (object ?? {}) as Record<string, unknown>;
    const company = asString(raw.company);
    const title = asString(raw.title);
    if (!company.trim() && !title.trim()) continue;
    entries.push({
      company,
      title,
      dates: asString(raw.dates),
      bullets: asStringArray(raw.bullets),
    });
  }
  return entries;
}

/**
 * A ParsedResume carrying only what the tailor stream has produced so far.
 *
 * Typed as the real thing because the panel renders it with the real
 * components, but it is a PREVIEW: the empty contact, projects, skills and
 * education are "not streamed", not "the model dropped them". It is never
 * cached, never downloaded, and never measured — the final frame's resume is
 * the only one that is. See RunState.streamingResume.
 */
export function partialResume(
  summary: string | null,
  experience: ExperienceEntry[],
): ParsedResume {
  return {
    contact: { name: "", email: "", phone: "", location: "", links: [] },
    summary: summary ?? "",
    experience,
    projects: [],
    skills: [],
    education: [],
  };
}
