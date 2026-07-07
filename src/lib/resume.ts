import type { ChatMessage } from "./llm";

// ---------------------------------------------------------------------------
// Structured resume shape (shared by the API route and the frontend)
// ---------------------------------------------------------------------------

export interface Contact {
  name: string;
  email: string;
  phone: string;
  location: string;
  links: string[];
}

export interface ExperienceEntry {
  company: string;
  title: string;
  dates: string;
  bullets: string[];
}

export interface ProjectEntry {
  name: string;
  description: string;
  bullets: string[];
}

export interface EducationEntry {
  school: string;
  degree: string;
  dates: string;
}

export interface ParsedResume {
  contact: Contact;
  summary: string;
  experience: ExperienceEntry[];
  projects: ProjectEntry[];
  skills: string[];
  education: EducationEntry[];
}

export const EMPTY_RESUME: ParsedResume = {
  contact: { name: "", email: "", phone: "", location: "", links: [] },
  summary: "",
  experience: [],
  projects: [],
  skills: [],
  education: [],
};

// ---------------------------------------------------------------------------
// Normalization — never trust the model to include every field.
// ---------------------------------------------------------------------------

function asString(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(asString).filter((s) => s.trim() !== "");
  if (typeof v === "string" && v.trim() !== "") {
    return v
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Coerce arbitrary parsed JSON into a complete, safe ParsedResume. */
export function normalizeResume(input: unknown): ParsedResume {
  const raw = (input ?? {}) as Record<string, unknown>;
  const contact = (raw.contact ?? {}) as Record<string, unknown>;

  return {
    contact: {
      name: asString(contact.name),
      email: asString(contact.email),
      phone: asString(contact.phone),
      location: asString(contact.location),
      links: asStringArray(contact.links),
    },
    summary: asString(raw.summary),
    experience: asArray(raw.experience).map((e) => {
      const x = (e ?? {}) as Record<string, unknown>;
      return {
        company: asString(x.company),
        title: asString(x.title),
        dates: asString(x.dates),
        bullets: asStringArray(x.bullets),
      };
    }),
    projects: asArray(raw.projects).map((p) => {
      const x = (p ?? {}) as Record<string, unknown>;
      return {
        name: asString(x.name),
        description: asString(x.description),
        bullets: asStringArray(x.bullets),
      };
    }),
    skills: asStringArray(raw.skills),
    education: asArray(raw.education).map((ed) => {
      const x = (ed ?? {}) as Record<string, unknown>;
      return {
        school: asString(x.school),
        degree: asString(x.degree),
        dates: asString(x.dates),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Parse prompt
// ---------------------------------------------------------------------------

const PARSE_SYSTEM = `You are a precise resume parser. You convert raw resume text into a single JSON object and nothing else.

Output EXACTLY this schema (use empty string "" or empty array [] when information is missing — never invent facts):

{
  "contact": { "name": "", "email": "", "phone": "", "location": "", "links": [] },
  "summary": "",
  "experience": [ { "company": "", "title": "", "dates": "", "bullets": [] } ],
  "projects": [ { "name": "", "description": "", "bullets": [] } ],
  "skills": [],
  "education": [ { "school": "", "degree": "", "dates": "" } ]
}

Rules:
- Preserve the candidate's original wording in bullets; do not embellish or rewrite.
- "dates" is a free-text range exactly as written (e.g. "Jan 2020 – Present").
- "links" holds URLs or handles (LinkedIn, GitHub, portfolio).
- "skills" is a flat list of individual skills.
- Respond with ONLY the JSON object. No markdown, no code fences, no commentary.`;

// ---------------------------------------------------------------------------
// Markdown rendering (for copy-to-clipboard)
// ---------------------------------------------------------------------------

export function resumeToMarkdown(resume: ParsedResume): string {
  const out: string[] = [];
  const c = resume.contact;

  if (c.name) out.push(`# ${c.name}`);
  const contactLine = [c.email, c.phone, c.location, ...c.links]
    .filter(Boolean)
    .join(" · ");
  if (contactLine) out.push(contactLine);

  if (resume.summary) {
    out.push("", "## Summary", resume.summary);
  }

  if (resume.experience.length > 0) {
    out.push("", "## Experience");
    for (const e of resume.experience) {
      const heading = [e.title, e.company].filter(Boolean).join(" — ");
      out.push("", `### ${heading || "Role"}`);
      if (e.dates) out.push(`*${e.dates}*`);
      for (const b of e.bullets) out.push(`- ${b}`);
    }
  }

  if (resume.projects.length > 0) {
    out.push("", "## Projects");
    for (const p of resume.projects) {
      out.push("", `### ${p.name || "Project"}`);
      if (p.description) out.push(p.description);
      for (const b of p.bullets) out.push(`- ${b}`);
    }
  }

  if (resume.skills.length > 0) {
    out.push("", "## Skills", resume.skills.join(", "));
  }

  if (resume.education.length > 0) {
    out.push("", "## Education");
    for (const ed of resume.education) {
      const heading = [ed.degree, ed.school].filter(Boolean).join(" — ");
      out.push("", `### ${heading || "Education"}`);
      if (ed.dates) out.push(`*${ed.dates}*`);
    }
  }

  return out.join("\n").trim() + "\n";
}

export function buildParseMessages(rawText: string): ChatMessage[] {
  return [
    { role: "system", content: PARSE_SYSTEM },
    {
      role: "user",
      content: `Parse the following resume into the JSON schema.\n\n--- RESUME TEXT START ---\n${rawText}\n--- RESUME TEXT END ---`,
    },
  ];
}
