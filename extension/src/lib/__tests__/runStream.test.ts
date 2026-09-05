import { describe, it, expect } from "vitest";
import { partialRows, partialExperience, partialResume } from "@/lib/runStream";

describe("partialRows", () => {
  // The whole point of mirroring the server's toStatus/toKind: a row painted
  // mid-stream must not change colour when the final frame replaces it with
  // the normalized one.
  it("coerces status and kind exactly as the server normalizer does", () => {
    expect(
      partialRows([
        { requirement: "Go", status: "MET", kind: "Nice-to-have" },
        { requirement: "K8s", status: "partial", kind: "nice" },
        { requirement: "Rust", status: "unclear", kind: "critical" },
        { requirement: "SQL" },
      ]),
    ).toEqual([
      { requirement: "Go", kind: "nice_to_have", status: "met", evidence: "", suggestion: "" },
      { requirement: "K8s", kind: "nice_to_have", status: "partially_met", evidence: "", suggestion: "" },
      { requirement: "Rust", kind: "must_have", status: "missing", evidence: "", suggestion: "" },
      { requirement: "SQL", kind: "must_have", status: "missing", evidence: "", suggestion: "" },
    ]);
  });

  // A blank line in the matrix reads as a bug; a missing line reads as "still
  // writing", which is the truth.
  it("drops rows with no requirement text", () => {
    expect(partialRows([{ requirement: "   " }, { status: "met" }, null, 7])).toEqual([]);
  });

  it("keeps evidence and suggestion as strings whatever arrives", () => {
    expect(partialRows([{ requirement: "Go", evidence: 5, suggestion: null }])[0]).toMatchObject({
      evidence: "5",
      suggestion: "",
    });
  });
});

describe("partialExperience", () => {
  it("keeps entries that name a company or a title, and coerces their bullets", () => {
    expect(
      partialExperience([
        { company: "Acme", title: "SRE", dates: "2020", bullets: ["a", "", 3] },
        { title: "Intern" },
        { dates: "2019" },
        {},
      ]),
    ).toEqual([
      { company: "Acme", title: "SRE", dates: "2020", bullets: ["a", "3"] },
      { company: "", title: "Intern", dates: "", bullets: [] },
    ]);
  });
});

describe("partialResume", () => {
  it("is a complete ParsedResume with the un-streamed sections empty", () => {
    expect(partialResume("A summary", [])).toEqual({
      contact: { name: "", email: "", phone: "", location: "", links: [] },
      summary: "A summary",
      experience: [],
      projects: [],
      skills: [],
      education: [],
    });
  });

  it("treats a not-yet-arrived summary as empty, never as the string null", () => {
    expect(partialResume(null, []).summary).toBe("");
  });
});
