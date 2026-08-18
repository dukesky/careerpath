import { describe, it, expect } from "vitest";
import { resumeFingerprint } from "@/lib/fingerprint";
import type { ParsedResume } from "@shared/contract";

function resume(overrides: Partial<ParsedResume> = {}): ParsedResume {
  return {
    contact: { name: "Ada Lovelace", email: "", phone: "", location: "", links: [] },
    summary: "Engineer",
    experience: [{ company: "Acme", title: "SWE", dates: "2020", bullets: ["Shipped X"] }],
    projects: [],
    skills: ["Python"],
    education: [],
    ...overrides,
  };
}

describe("resumeFingerprint", () => {
  it("is stable across separate objects with the same content", () => {
    expect(resumeFingerprint(resume())).toBe(resumeFingerprint(resume()));
  });

  it("changes when a skill is added", () => {
    expect(resumeFingerprint(resume({ skills: ["Python", "Rust"] }))).not.toBe(
      resumeFingerprint(resume()),
    );
  });

  // The case that motivates the whole feature: the user replaces their resume,
  // and every cached result computed from the old one must stop counting.
  it("changes when a bullet is edited", () => {
    const edited = resume({
      experience: [
        { company: "Acme", title: "SWE", dates: "2020", bullets: ["Shipped Y"] },
      ],
    });
    expect(resumeFingerprint(edited)).not.toBe(resumeFingerprint(resume()));
  });

  it("returns a short hex string", () => {
    expect(resumeFingerprint(resume())).toMatch(/^[0-9a-f]{8}$/);
  });
});
