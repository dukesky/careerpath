import { describe, it, expect } from "vitest";
import { buildAnalyzeMessages, buildTailorMessages } from "@/lib/analysis";
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

describe("ANALYZE_SYSTEM slimming", () => {
  // The system prompt is not exported; assert through the built messages.
  it("carries the brevity caps and keeps the schema order", () => {
    const msgs = buildAnalyzeMessages(RESUME, JD, "");
    const sys = msgs[0].content;
    expect(sys).toContain("at most 2 sentences"); // rationale cap
    expect(sys).toContain("15 words or fewer"); // evidence/suggestion cap
    expect(sys).toContain("top 3 strengths");
    expect(sys).toContain("at most 3 gaps");
    // Field order is the streaming contract: the score must stream first.
    expect(sys.indexOf('"overall_match_score"')).toBeLessThan(sys.indexOf('"rationale"'));
    expect(sys.indexOf('"rationale"')).toBeLessThan(sys.indexOf('"requirements_matrix"'));
  });

  // The slimming is a budget change, not a calibration change: the persona and
  // the honest-scoring clauses are what make the score mean anything, and they
  // are shared with /api/rescore, whose whole premise is "same instrument".
  it("keeps the scoring persona and the honest-calibration clauses word for word", () => {
    const sys = buildAnalyzeMessages(RESUME, JD, "")[0].content;
    expect(sys).toContain(
      "You are a rigorous, honest technical recruiter and career coach.",
    );
    expect(sys).toContain(
      "You never flatter and never invent evidence — every claim must be grounded in the provided resume or extra info.",
    );
    expect(sys).toContain(
      '"overall_match_score": integer 0-100. Calibrate honestly — missing several must-haves should score low.',
    );
    expect(sys).toContain("do not fabricate");
    expect(sys).toContain("never advise fabrication");
  });
});

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
    // Vocabulary alignment must not become relabelling: the bench caught the model
    // upgrading ad-hoc snapshotting into "slowly changing dimensions" to reach a JD term.
    expect(userWith).toContain("Never relabel the candidate's work");
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
