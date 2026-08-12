import type { ParsedResume } from "@shared/contract";

/**
 * Flattens a ParsedResume into what the panel draws.
 *
 * This is a pure function on purpose: the extension has no React test
 * harness, so keeping the shaping logic out of the component is what makes
 * the display's one load-bearing rule — an empty section still appears —
 * testable at all.
 */

export interface BreakdownEntry {
  title: string;
  detail: string;
  bullets: string[];
}

export interface BreakdownSection {
  label: string;
  /** Empty means the parser did not detect this section. Render it as such. */
  entries: BreakdownEntry[];
}

const present = (s: string): boolean => s.trim() !== "";

// Filters blank bullets here, not just at each call site, so `hasContent`
// below — which trusts `bullets.length` — sees the truth: a bullet list
// made only of whitespace strings must count as no bullets, or an entry
// with nothing else renders as visible empty list markers.
const entry = (
  title: string,
  detail = "",
  bullets: string[] = [],
): BreakdownEntry => ({ title, detail, bullets: bullets.filter(present) });

/**
 * An entry with no title, no detail, and no bullets is invisible in the UI —
 * a blank div. That is the same "looks fine, is wrong" failure the whole
 * feature exists to prevent, so a wholly-blank entry is dropped rather than
 * kept as a silent gap. If every entry in a section drops, the section is
 * empty and reads as "Not detected", which is the correct signal.
 */
const hasContent = (e: BreakdownEntry): boolean =>
  present(e.title) || present(e.detail) || e.bullets.length > 0;

export function toBreakdown(resume: ParsedResume): BreakdownSection[] {
  const { contact } = resume;
  const contactBullets = [contact.email, contact.phone, contact.location, ...contact.links]
    .filter(present);
  const hasContact = present(contact.name) || contactBullets.length > 0;

  return [
    {
      label: "Contact",
      entries: hasContact ? [entry(contact.name, "", contactBullets)] : [],
    },
    {
      label: "Summary",
      entries: present(resume.summary) ? [entry(resume.summary)] : [],
    },
    {
      label: "Experience",
      entries: resume.experience
        .map((e) =>
          entry(
            [e.title, e.company].filter(present).join(" · "),
            e.dates,
            e.bullets,
          ),
        )
        .filter(hasContent),
    },
    {
      label: "Projects",
      entries: resume.projects
        .map((p) => entry(p.name, p.description, p.bullets))
        .filter(hasContent),
    },
    {
      label: "Skills",
      entries: resume.skills.length > 0 ? [entry(resume.skills.join(", "))] : [],
    },
    {
      label: "Education",
      entries: resume.education
        .map((e) => entry([e.degree, e.school].filter(present).join(" · "), e.dates))
        .filter(hasContent),
    },
  ];
}
