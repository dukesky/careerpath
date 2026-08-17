import type { GapAnalysis } from "@shared/contract";

const GENERIC =
  "Anything not on your resume — projects, skills, or context you want considered.";

/** Naming more than this wraps the placeholder in a 400px panel. */
const MAX_EXAMPLES = 3;

/**
 * The supplement box's placeholder, naming the requirements THIS analysis
 * marked missing.
 *
 * A fixed example would not tell the user what the box is for; their own gaps
 * do, and it costs nothing — the data is already on screen above the box.
 */
export function supplementPlaceholder(analysis: GapAnalysis | null): string {
  const missing = (analysis?.requirements_matrix ?? [])
    .filter((r) => r.status === "missing")
    .map((r) => r.requirement.trim())
    .filter(Boolean)
    .slice(0, MAX_EXAMPLES);

  if (missing.length === 0) return GENERIC;
  return `e.g. ${missing.join(", ")} — tell us what you actually did with them.`;
}
