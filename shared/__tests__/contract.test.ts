import { describe, it, expect } from "vitest";
import { normalizeResume } from "@/lib/resume";
import { normalizeJD } from "@/lib/jd";
import { normalizeGapAnalysis, normalizeTailorResult } from "@/lib/analysis";
import type {
  ParsedResume,
  ParsedJD,
  GapAnalysis,
  TailorResult,
} from "@shared/contract";
import * as contract from "@shared/contract";

describe("shared contract", () => {
  it("exports no runtime values", () => {
    expect(Object.keys(contract)).toHaveLength(0);
  });

  it("normalizeResume produces a ParsedResume", () => {
    const r: ParsedResume = normalizeResume({ summary: "hi" });
    expect(r.summary).toBe("hi");
    expect(r.contact.name).toBe("");
    expect(r.experience).toEqual([]);
    expect(r.skills).toEqual([]);
  });

  it("normalizeJD produces a ParsedJD", () => {
    const j: ParsedJD = normalizeJD({ company: "Acme" });
    expect(j.company).toBe("Acme");
    expect(j.must_have_requirements).toEqual([]);
    expect(j.keywords).toEqual([]);
  });

  it("normalizeGapAnalysis produces a GapAnalysis", () => {
    const a: GapAnalysis = normalizeGapAnalysis({ overall_match_score: 77 });
    expect(a.overall_match_score).toBe(77);
    expect(a.requirements_matrix).toEqual([]);
    expect(a.gaps).toEqual([]);
  });

  it("normalizeTailorResult produces a TailorResult", () => {
    const t: TailorResult = normalizeTailorResult({ projected_match_score: 88 });
    expect(t.projected_match_score).toBe(88);
    expect(t.change_log).toEqual([]);
    expect(t.resume.contact.email).toBe("");
  });
});
