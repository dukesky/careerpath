import { describe, it, expect } from "vitest";
import { buildTailorMessages } from "@/lib/analysis";
import type { ParsedResume } from "@/lib/resume";
import type { ParsedJD } from "@/lib/jd";
import type { GapAnalysis } from "@shared/contract";

const RESUME = {
  contact: { name: "Ada", email: "", phone: "", location: "", links: [] },
  summary: "", experience: [], projects: [], skills: [], education: [],
} as ParsedResume;
const JD = { company: "Acme", role_title: "SRE" } as unknown as ParsedJD;
const ANALYSIS: GapAnalysis = {
  overall_match_score: 70, rationale: "",
  requirements_matrix: [{
    requirement: "Kubernetes", kind: "must_have", status: "partially_met",
    evidence: "ran EKS clusters", suggestion: "surface the operator work",
  }],
  strengths: [], gaps: [],
};

describe("buildTailorMessages targeted uplift", () => {
  it("adds the targeted-uplift directive only when an analysis is provided", () => {
    const withA = buildTailorMessages(RESUME, JD, "", true, ANALYSIS);
    const without = buildTailorMessages(RESUME, JD, "", true, null);
    const userWith = withA[1].content;
    const userWithout = without[1].content;
    expect(userWith).toContain("GAP ANALYSIS (target the uplift honestly)");
    expect(userWith).toContain("partially_met");
    // The uplift instruction must stay subordinate to the no-fabrication rule:
    // this clause is what stops it reading as a licence to invent evidence.
    expect(userWith).toContain(
      "subordinate to the traceability test above — it never licenses adding a fact",
    );
    // The directive names the hard boundary so the model sees it next to the data.
    expect(userWith).toContain("do NOT touch");
    expect(userWithout).not.toContain("GAP ANALYSIS");
  });

  it("does not change the analysis-free message at all", () => {
    const a = buildTailorMessages(RESUME, JD, "extra", false, null);
    // Byte-identity contract: lock the FULL analysis-free user message, so any
    // new text on this path — uplift-related or not — fails here.
    expect(a[1].content).toMatchInlineSnapshot(`
      "Rewrite the resume to target this role. Obey the no-fabrication constraint.

      --- CANDIDATE RESUME (JSON) ---
      {
        "contact": {
          "name": "Ada",
          "email": "",
          "phone": "",
          "location": "",
          "links": []
        },
        "summary": "",
        "experience": [],
        "projects": [],
        "skills": [],
        "education": []
      }

      --- EXTRA INFO FROM CANDIDATE (real facts to use) ---
      "extra"

      --- JOB DESCRIPTION (JSON) ---
      {
        "company": "Acme",
        "role_title": "SRE"
      }

      SUMMARY: Do NOT include a summary. Set the resume "summary" field to an empty string ""."
    `);
  });
});
