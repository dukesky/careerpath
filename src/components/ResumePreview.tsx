"use client";

import type {
  EducationEntry,
  ExperienceEntry,
  ParsedResume,
  ProjectEntry,
} from "@/lib/resume";

/**
 * Fully editable, controlled preview of a parsed resume.
 * State lives in the parent — this component only reports changes upward.
 */
export function ResumePreview({
  resume,
  onChange,
}: {
  resume: ParsedResume;
  onChange: (next: ParsedResume) => void;
}) {
  function patch(partial: Partial<ParsedResume>) {
    onChange({ ...resume, ...partial });
  }

  return (
    <div className="space-y-6">
      {/* Contact */}
      <Section title="Contact">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Name"
            value={resume.contact.name}
            onChange={(v) =>
              patch({ contact: { ...resume.contact, name: v } })
            }
          />
          <Field
            label="Email"
            value={resume.contact.email}
            onChange={(v) =>
              patch({ contact: { ...resume.contact, email: v } })
            }
          />
          <Field
            label="Phone"
            value={resume.contact.phone}
            onChange={(v) =>
              patch({ contact: { ...resume.contact, phone: v } })
            }
          />
          <Field
            label="Location"
            value={resume.contact.location}
            onChange={(v) =>
              patch({ contact: { ...resume.contact, location: v } })
            }
          />
        </div>
        <div className="mt-3">
          <ListField
            label="Links (one per line)"
            value={resume.contact.links}
            onChange={(links) => patch({ contact: { ...resume.contact, links } })}
          />
        </div>
      </Section>

      {/* Summary */}
      <Section title="Summary">
        <AutoTextarea
          value={resume.summary}
          rows={3}
          placeholder="Professional summary…"
          onChange={(v) => patch({ summary: v })}
        />
      </Section>

      {/* Experience */}
      <Section
        title="Experience"
        onAdd={() =>
          patch({
            experience: [
              ...resume.experience,
              { company: "", title: "", dates: "", bullets: [] },
            ],
          })
        }
      >
        {resume.experience.length === 0 && <EmptyHint text="No experience yet." />}
        <div className="space-y-4">
          {resume.experience.map((exp, i) => (
            <EntryCard
              key={i}
              onRemove={() =>
                patch({
                  experience: resume.experience.filter((_, j) => j !== i),
                })
              }
            >
              <ExperienceFields
                value={exp}
                onChange={(next) =>
                  patch({
                    experience: resume.experience.map((e, j) =>
                      j === i ? next : e,
                    ),
                  })
                }
              />
            </EntryCard>
          ))}
        </div>
      </Section>

      {/* Projects */}
      <Section
        title="Projects"
        onAdd={() =>
          patch({
            projects: [
              ...resume.projects,
              { name: "", description: "", bullets: [] },
            ],
          })
        }
      >
        {resume.projects.length === 0 && <EmptyHint text="No projects yet." />}
        <div className="space-y-4">
          {resume.projects.map((proj, i) => (
            <EntryCard
              key={i}
              onRemove={() =>
                patch({ projects: resume.projects.filter((_, j) => j !== i) })
              }
            >
              <ProjectFields
                value={proj}
                onChange={(next) =>
                  patch({
                    projects: resume.projects.map((p, j) =>
                      j === i ? next : p,
                    ),
                  })
                }
              />
            </EntryCard>
          ))}
        </div>
      </Section>

      {/* Skills */}
      <Section title="Skills">
        <ListField
          label="Skills (one per line)"
          value={resume.skills}
          onChange={(skills) => patch({ skills })}
        />
      </Section>

      {/* Education */}
      <Section
        title="Education"
        onAdd={() =>
          patch({
            education: [
              ...resume.education,
              { school: "", degree: "", dates: "" },
            ],
          })
        }
      >
        {resume.education.length === 0 && <EmptyHint text="No education yet." />}
        <div className="space-y-4">
          {resume.education.map((ed, i) => (
            <EntryCard
              key={i}
              onRemove={() =>
                patch({ education: resume.education.filter((_, j) => j !== i) })
              }
            >
              <EducationFields
                value={ed}
                onChange={(next) =>
                  patch({
                    education: resume.education.map((e, j) =>
                      j === i ? next : e,
                    ),
                  })
                }
              />
            </EntryCard>
          ))}
        </div>
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Entry field groups
// ---------------------------------------------------------------------------

function ExperienceFields({
  value,
  onChange,
}: {
  value: ExperienceEntry;
  onChange: (next: ExperienceEntry) => void;
}) {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Company"
          value={value.company}
          onChange={(v) => onChange({ ...value, company: v })}
        />
        <Field
          label="Title"
          value={value.title}
          onChange={(v) => onChange({ ...value, title: v })}
        />
      </div>
      <div className="mt-3">
        <Field
          label="Dates"
          value={value.dates}
          onChange={(v) => onChange({ ...value, dates: v })}
        />
      </div>
      <div className="mt-3">
        <ListField
          label="Bullets (one per line)"
          value={value.bullets}
          onChange={(bullets) => onChange({ ...value, bullets })}
        />
      </div>
    </>
  );
}

function ProjectFields({
  value,
  onChange,
}: {
  value: ProjectEntry;
  onChange: (next: ProjectEntry) => void;
}) {
  return (
    <>
      <Field
        label="Name"
        value={value.name}
        onChange={(v) => onChange({ ...value, name: v })}
      />
      <div className="mt-3">
        <AutoTextarea
          value={value.description}
          rows={2}
          placeholder="Short description…"
          onChange={(v) => onChange({ ...value, description: v })}
        />
      </div>
      <div className="mt-3">
        <ListField
          label="Bullets (one per line)"
          value={value.bullets}
          onChange={(bullets) => onChange({ ...value, bullets })}
        />
      </div>
    </>
  );
}

function EducationFields({
  value,
  onChange,
}: {
  value: EducationEntry;
  onChange: (next: EducationEntry) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <Field
        label="School"
        value={value.school}
        onChange={(v) => onChange({ ...value, school: v })}
      />
      <Field
        label="Degree"
        value={value.degree}
        onChange={(v) => onChange({ ...value, degree: v })}
      />
      <Field
        label="Dates"
        value={value.dates}
        onChange={(v) => onChange({ ...value, dates: v })}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

function Section({
  title,
  children,
  onAdd,
}: {
  title: string;
  children: React.ReactNode;
  onAdd?: () => void;
}) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          {title}
        </h3>
        {onAdd && (
          <button
            type="button"
            onClick={onAdd}
            className="rounded-md px-2 py-1 text-xs font-medium text-indigo-600 transition hover:bg-indigo-50"
          >
            + Add
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

function EntryCard({
  children,
  onRemove,
}: {
  children: React.ReactNode;
  onRemove: () => void;
}) {
  return (
    <div className="relative rounded-xl border border-slate-200 bg-slate-50/60 p-4">
      <button
        type="button"
        onClick={onRemove}
        className="absolute right-2 top-2 rounded-md p-1 text-slate-400 transition hover:bg-slate-200 hover:text-slate-700"
        aria-label="Remove entry"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          className="h-4 w-4"
          aria-hidden="true"
        >
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
      {children}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-500">
        {label}
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
      />
    </label>
  );
}

function AutoTextarea({
  value,
  onChange,
  rows,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  rows: number;
  placeholder?: string;
}) {
  return (
    <textarea
      value={value}
      rows={rows}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className="w-full resize-y rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
    />
  );
}

/** Edits a string[] as a newline-separated textarea. */
function ListField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string[];
  onChange: (v: string[]) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-500">
        {label}
      </span>
      <textarea
        value={value.join("\n")}
        rows={Math.max(2, value.length)}
        onChange={(e) =>
          onChange(
            e.target.value.split("\n").map((s) => s.replace(/^[-•]\s*/, "")),
          )
        }
        className="w-full resize-y rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
      />
    </label>
  );
}

function EmptyHint({ text }: { text: string }) {
  return <p className="mb-3 text-sm text-slate-400">{text}</p>;
}
