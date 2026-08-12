import { describe, it, expect } from "vitest";
import { toBreakdown } from "@/sidepanel/breakdown";
import type { ParsedResume } from "@shared/contract";

const EMPTY: ParsedResume = {
  contact: { name: "", email: "", phone: "", location: "", links: [] },
  summary: "",
  experience: [],
  projects: [],
  skills: [],
  education: [],
};

describe("toBreakdown", () => {
  it("always returns all six sections, in a stable order", () => {
    expect(toBreakdown(EMPTY).map((s) => s.label)).toEqual([
      "Contact",
      "Summary",
      "Experience",
      "Projects",
      "Skills",
      "Education",
    ]);
  });

  // The point of the whole feature: a section the parser dropped must still
  // appear, empty, so the user can SEE that it was dropped. Hiding it would
  // make a wrong parse look right.
  it("keeps a section the parser returned empty, with no entries", () => {
    const projects = toBreakdown(EMPTY).find((s) => s.label === "Projects");
    expect(projects).toBeDefined();
    expect(projects!.entries).toEqual([]);
  });

  it("renders an experience entry with its bullets", () => {
    const r: ParsedResume = {
      ...EMPTY,
      experience: [
        {
          company: "Acme",
          title: "Backend Engineer",
          dates: "2022–2024",
          bullets: ["Built a thing", "Fixed another thing"],
        },
      ],
    };
    const exp = toBreakdown(r).find((s) => s.label === "Experience")!;
    expect(exp.entries).toEqual([
      {
        title: "Backend Engineer · Acme",
        detail: "2022–2024",
        bullets: ["Built a thing", "Fixed another thing"],
      },
    ]);
  });

  it("collapses contact into one entry and drops blank fields", () => {
    const r: ParsedResume = {
      ...EMPTY,
      contact: {
        name: "Ada Lovelace",
        email: "ada@example.com",
        phone: "",
        location: "London",
        links: ["https://example.com"],
      },
    };
    const contact = toBreakdown(r).find((s) => s.label === "Contact")!;
    expect(contact.entries).toHaveLength(1);
    expect(contact.entries[0].title).toBe("Ada Lovelace");
    expect(contact.entries[0].bullets).toEqual([
      "ada@example.com",
      "London",
      "https://example.com",
    ]);
  });

  it("puts every skill in one entry rather than one entry per skill", () => {
    const r: ParsedResume = { ...EMPTY, skills: ["Go", "Postgres", "Kubernetes"] };
    const skills = toBreakdown(r).find((s) => s.label === "Skills")!;
    expect(skills.entries).toEqual([
      { title: "Go, Postgres, Kubernetes", detail: "", bullets: [] },
    ]);
  });

  it("treats a whitespace-only summary as not detected", () => {
    const r: ParsedResume = { ...EMPTY, summary: "   " };
    expect(toBreakdown(r).find((s) => s.label === "Summary")!.entries).toEqual([]);
  });

  // A garbled parse can hand back an entry with no title, no detail, and no
  // bullets. Keeping it would render an invisible empty div — the same
  // "looks fine, is wrong" failure the feature exists to prevent. It must
  // be dropped rather than shown as a blank line.
  it("drops a wholly-blank experience entry but keeps a real one alongside it", () => {
    const r: ParsedResume = {
      ...EMPTY,
      experience: [
        { company: "", title: "", dates: "", bullets: [] },
        {
          company: "Acme",
          title: "Backend Engineer",
          dates: "2022–2024",
          bullets: ["Built a thing"],
        },
      ],
    };
    const exp = toBreakdown(r).find((s) => s.label === "Experience")!;
    expect(exp.entries).toEqual([
      { title: "Backend Engineer · Acme", detail: "2022–2024", bullets: ["Built a thing"] },
    ]);
  });

  it("treats a section made only of blank entries as not detected", () => {
    const r: ParsedResume = {
      ...EMPTY,
      projects: [{ name: "", description: "", bullets: [] }],
    };
    const projects = toBreakdown(r).find((s) => s.label === "Projects")!;
    expect(projects.entries).toEqual([]);
  });
});
