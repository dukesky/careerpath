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

describe("raw-JD input", () => {
  it("renders a raw-text JD block when given { rawText }", () => {
    const msgs = buildAnalyzeMessages(RESUME, { rawText: "We need Kubernetes and Go." }, "");
    expect(msgs[1].content).toContain("JOB DESCRIPTION (raw text)");
    expect(msgs[1].content).toContain("We need Kubernetes and Go.");
    expect(msgs[1].content).not.toContain("JOB DESCRIPTION (JSON)");
    const t = buildTailorMessages(RESUME, { rawText: "We need Kubernetes." }, "", true, null);
    expect(t[1].content).toContain("JOB DESCRIPTION (raw text)");
    expect(t[1].content).not.toContain("JOB DESCRIPTION (JSON)");
  });

  // The raw text goes in verbatim — no JSON.stringify, so no escaped newlines
  // or wrapping quotes between the model and the posting it must read.
  it("does not JSON-encode the raw text", () => {
    const msgs = buildAnalyzeMessages(RESUME, { rawText: 'Line 1\n"quoted"' }, "");
    expect(msgs[1].content).toContain('--- JOB DESCRIPTION (raw text) ---\nLine 1\n"quoted"');
  });

  // The ParsedJD path must stay byte-identical: the inline snapshot below is
  // the guard for tailor, and this is the guard for analyze. A raw-JD change
  // that leaks into this branch changes what /api/rescore measures with.
  it("keeps the ParsedJD path byte-identical", () => {
    const msgs = buildAnalyzeMessages(RESUME, JD, "extra");
    expect(msgs[1].content).toMatchInlineSnapshot(`
      "Analyze this candidate's fit for the role.

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

      --- EXTRA INFO FROM CANDIDATE (not on resume) ---
      "extra"

      --- JOB DESCRIPTION (JSON) ---
      {
        "company": "Acme",
        "role_title": "SRE"
      }"
    `);
  });
});

describe("TAILOR_SYSTEM change_log slimming", () => {
  const sys = () => buildTailorMessages(RESUME, JD, "", true, null)[0].content;

  it("bounds change_log entries to one line", () => {
    expect(sys()).toContain(
      '"original" and "revised" are snippets of 10 words or fewer; "reason" is one short sentence',
    );
  });

  // The change_log is a display artifact; the anti-fabrication machinery is
  // the product. Trimming the former must not touch the latter, so pin the
  // traceability test and the failure modes it enumerates word for word.
  it("leaves the traceability test and the failure modes untouched", () => {
    const s = sys();
    expect(s).toContain(
      "THE TRACEABILITY TEST — apply it to every sentence you write:",
    );
    expect(s).toContain(
      "A rewrite may compress, reorder, or sharpen its source; it must never say MORE than the source",
    );
    expect(s).toContain("DERIVED AGGREGATES: never do arithmetic over the resume.");
    // The anti-relabel clause: the bench caught the model upgrading a tool it
    // was never given, and this is the line that forbids it.
    expect(s).toContain(
      "UPGRADED TOOLS AND LABELS: never name a tool, technology, ecosystem, or affiliation the source does not name for that same piece of work.",
    );
    expect(s).toContain("IMPORTED JOB-DESCRIPTION LANGUAGE");
    expect(s).toContain("INVENTED MECHANISMS");
    expect(s).toContain("INFLATED SCOPE OR SPECIFICITY");
  });

  // The bench caught the tailor lifting a bullet out of the 2019–2022 employer
  // and re-filing it under the current one to match the job. That rewrites who
  // the candidate was when they did the work, so it is fabrication.
  it("forbids migrating accomplishments between employers", () => {
    const s = sys();
    expect(s).toContain("CROSS-ROLE ATTRIBUTION");
    expect(s).toContain("never migrate between roles");
  });

  // The slimmed one-line instruction backfired: entries got MORE numerous, and
  // one output logged a change it had reverted. Cap the count, and require
  // every entry to describe an edit actually present in the output.
  it("caps change_log entries and requires them to be real", () => {
    const s = sys();
    expect(s).toContain("At most 6 entries");
    expect(s).toContain(
      "Every entry must describe an edit that IS present in the output resume",
    );
  });

  // Bench iteration 2: 4/12 outputs logged reorders the resume does not show,
  // and 2 more burned a capped slot on an "Order unchanged" non-edit. Name the
  // "no change" note as forbidden, and make the model verify each entry against
  // its own output before emitting the log.
  it("forbids no-change notes and demands a self-check against the output", () => {
    const s = sys();
    expect(s).toContain('a "no change" note');
    expect(s).toContain("Before emitting the log, check each entry against your own output");
    expect(s).toContain("fabrication about your work");
  });
});

describe("TAILOR_SYSTEM shape neutrality", () => {
  it("APPROACH step 1 names no ParsedJD field — it must work for raw-text JDs", () => {
    const sys = buildTailorMessages(RESUME, { rawText: "Some posting" }, "", true, null)[0].content;
    expect(sys).toContain("hard requirements and its concrete technology and domain terms");
    expect(sys).not.toContain("must_have_requirements and keywords");
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
