import { describe, it, expect } from "vitest";
import { supplementPlaceholder } from "../gapHint";
import type { GapAnalysis, RequirementRow } from "@shared/contract";

function row(requirement: string, status: RequirementRow["status"]): RequirementRow {
  return { requirement, kind: "must_have", status, evidence: "", suggestion: "" };
}

function analysis(rows: RequirementRow[]): GapAnalysis {
  return {
    overall_match_score: 60,
    rationale: "",
    requirements_matrix: rows,
    strengths: [],
    gaps: [],
  };
}

describe("supplementPlaceholder", () => {
  const GENERIC =
    "Anything not on your resume — projects, skills, or context you want considered.";

  it("falls back to the generic prompt when there is no analysis", () => {
    expect(supplementPlaceholder(null)).toBe(GENERIC);
  });

  it("falls back to the generic prompt when nothing is missing", () => {
    expect(supplementPlaceholder(analysis([row("Python", "met")]))).toBe(GENERIC);
  });

  it("names the requirements this analysis marked missing", () => {
    const got = supplementPlaceholder(
      analysis([row("Python", "met"), row("PyTorch", "missing"), row("Kubernetes", "missing")]),
    );
    expect(got).toBe("e.g. PyTorch, Kubernetes — tell us what you actually did with them.");
  });

  it("ignores partially met requirements", () => {
    const got = supplementPlaceholder(
      analysis([row("Go", "partially_met"), row("Rust", "missing")]),
    );
    expect(got).toBe("e.g. Rust — tell us what you actually did with them.");
  });

  // The panel is 400px wide. Naming every gap would wrap the placeholder into
  // a paragraph and stop it reading as an example.
  it("names at most three", () => {
    const got = supplementPlaceholder(
      analysis([
        row("A", "missing"),
        row("B", "missing"),
        row("C", "missing"),
        row("D", "missing"),
      ]),
    );
    expect(got).toBe("e.g. A, B, C — tell us what you actually did with them.");
  });

  it("skips blank requirement strings rather than emitting empty examples", () => {
    const got = supplementPlaceholder(analysis([row("  ", "missing"), row("Rust", "missing")]));
    expect(got).toBe("e.g. Rust — tell us what you actually did with them.");
  });
});
