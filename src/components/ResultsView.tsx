"use client";

import { useMemo, useState } from "react";
import type {
  ChangeLogEntry,
  GapAnalysis,
  ReqStatus,
  TailorResult,
} from "@/lib/analysis";
import { resumeToMarkdown, type ParsedResume } from "@/lib/resume";
import { ResumePreview } from "@/components/ResumePreview";
import { ResumeDiff } from "@/components/ResumeDiff";
import { SignedIn, SignedOut, SignInButton } from "@/components/clerk-auth";

export function ResultsView({
  analysis,
  tailored,
  originalResume,
  generatedResume,
  company,
  onSave,
  saveState,
  onTailoredResumeChange,
  onBack,
}: {
  analysis: GapAnalysis;
  tailored: TailorResult;
  originalResume: ParsedResume;
  generatedResume: ParsedResume;
  company: string;
  onSave: () => void;
  saveState: "idle" | "saving" | "saved" | "error";
  onTailoredResumeChange: (resume: ParsedResume) => void;
  onBack: () => void;
}) {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-600 hover:text-slate-900"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-4 w-4"
            aria-hidden="true"
          >
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
          Back to inputs
        </button>
      </div>

      <ScoreCard analysis={analysis} />
      <RequirementsTable analysis={analysis} />
      <StrengthsGaps analysis={analysis} />
      <TailoredResumeCard
        tailored={tailored}
        originalResume={originalResume}
        generatedResume={generatedResume}
        company={company}
        beforeScore={analysis.overall_match_score}
        onSave={onSave}
        saveState={saveState}
        onChange={onTailoredResumeChange}
      />

      <Disclaimer />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Score
// ---------------------------------------------------------------------------

function scoreTone(score: number): { text: string; ring: string; label: string } {
  if (score >= 75)
    return { text: "text-emerald-600", ring: "ring-emerald-200", label: "Strong match" };
  if (score >= 50)
    return { text: "text-amber-600", ring: "ring-amber-200", label: "Partial match" };
  return { text: "text-rose-600", ring: "ring-rose-200", label: "Stretch" };
}

function ScoreCard({ analysis }: { analysis: GapAnalysis }) {
  const tone = scoreTone(analysis.overall_match_score);
  return (
    <div className="flex flex-col gap-5 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:flex-row sm:items-center">
      <div
        className={`grid h-24 w-24 shrink-0 place-items-center rounded-full bg-slate-50 ring-8 ${tone.ring}`}
      >
        <div className="text-center">
          <div className={`text-3xl font-bold ${tone.text}`}>
            {analysis.overall_match_score}
          </div>
          <div className="text-[10px] font-medium uppercase tracking-wide text-slate-400">
            / 100
          </div>
        </div>
      </div>
      <div>
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold text-slate-900">Match score</h2>
          <span className={`text-sm font-medium ${tone.text}`}>{tone.label}</span>
        </div>
        <p className="mt-1.5 text-sm leading-relaxed text-slate-600">
          {analysis.rationale}
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Requirements matrix
// ---------------------------------------------------------------------------

const STATUS_STYLE: Record<ReqStatus, { label: string; cls: string }> = {
  met: { label: "Met", cls: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
  partially_met: {
    label: "Partial",
    cls: "bg-amber-50 text-amber-700 ring-amber-200",
  },
  missing: { label: "Missing", cls: "bg-rose-50 text-rose-700 ring-rose-200" },
};

function StatusBadge({ status }: { status: ReqStatus }) {
  const s = STATUS_STYLE[status];
  return (
    <span
      className={`inline-block whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ${s.cls}`}
    >
      {s.label}
    </span>
  );
}

function RequirementsTable({ analysis }: { analysis: GapAnalysis }) {
  if (analysis.requirements_matrix.length === 0) return null;
  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-100 px-6 py-4">
        <h2 className="text-base font-semibold text-slate-900">
          Requirements matrix
        </h2>
        <p className="text-sm text-slate-500">
          How your resume maps to each requirement.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead>
            <tr className="border-b border-slate-100 text-xs uppercase tracking-wide text-slate-400">
              <th className="px-6 py-3 font-medium">Requirement</th>
              <th className="px-3 py-3 font-medium">Status</th>
              <th className="px-3 py-3 font-medium">Evidence</th>
              <th className="px-6 py-3 font-medium">Suggestion</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {analysis.requirements_matrix.map((row, i) => (
              <tr key={i} className="align-top">
                <td className="px-6 py-4">
                  <div className="font-medium text-slate-800">
                    {row.requirement}
                  </div>
                  <span className="mt-1 inline-block rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-500">
                    {row.kind === "must_have" ? "Must-have" : "Nice-to-have"}
                  </span>
                </td>
                <td className="px-3 py-4">
                  <StatusBadge status={row.status} />
                </td>
                <td className="px-3 py-4 text-slate-600">{row.evidence}</td>
                <td className="px-6 py-4 text-slate-600">{row.suggestion}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Strengths + gaps
// ---------------------------------------------------------------------------

function StrengthsGaps({ analysis }: { analysis: GapAnalysis }) {
  if (analysis.strengths.length === 0 && analysis.gaps.length === 0) return null;
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">
          Strengths to emphasize
        </h2>
        <ul className="mt-3 space-y-2">
          {analysis.strengths.map((s, i) => (
            <li key={i} className="flex gap-2 text-sm text-slate-700">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
              {s}
            </li>
          ))}
        </ul>
      </div>
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">
          Gaps &amp; honest mitigation
        </h2>
        <ul className="mt-3 space-y-3">
          {analysis.gaps.map((g, i) => (
            <li key={i} className="text-sm">
              <div className="font-medium text-slate-800">{g.gap}</div>
              <div className="mt-0.5 text-slate-600">{g.mitigation}</div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tailored resume
// ---------------------------------------------------------------------------

type ResumeTab = "preview" | "diff" | "changes" | "edit";

function TailoredResumeCard({
  tailored,
  originalResume,
  generatedResume,
  company,
  beforeScore,
  onSave,
  saveState,
  onChange,
}: {
  tailored: TailorResult;
  originalResume: ParsedResume;
  generatedResume: ParsedResume;
  company: string;
  beforeScore: number;
  onSave: () => void;
  saveState: "idle" | "saving" | "saved" | "error";
  onChange: (resume: ParsedResume) => void;
}) {
  const resume = tailored.resume;
  const afterScore = tailored.projected_match_score;
  const [tab, setTab] = useState<ResumeTab>("preview");
  const [copied, setCopied] = useState(false);
  const [exporting, setExporting] = useState(false);

  const originalMd = useMemo(
    () => resumeToMarkdown(originalResume),
    [originalResume],
  );
  const revisedMd = useMemo(() => resumeToMarkdown(resume), [resume]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(revisedMd);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  async function exportPdf() {
    setExporting(true);
    try {
      // Dynamic import keeps the heavy PDF library out of the initial bundle.
      const { generateResumePdf, resumePdfFilename } = await import(
        "@/lib/resume-pdf"
      );
      const blob = await generateResumePdf(resume);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = resumePdfFilename(resume.contact.name, company);
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      // no-op — button re-enables so the user can retry
    } finally {
      setExporting(false);
    }
  }

  const afterTone = scoreTone(afterScore);
  const delta = afterScore - beforeScore;

  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
      {/* Before → after match score — the product's value at a glance. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-slate-100 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="text-center">
            <div className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
              Original
            </div>
            <div className="text-xl font-bold text-slate-500">{beforeScore}</div>
          </div>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-5 w-5 text-slate-300"
            aria-hidden="true"
          >
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
          <div className="text-center">
            <div className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
              Tailored
            </div>
            <div className={`text-2xl font-bold ${afterTone.text}`}>
              {afterScore}
            </div>
          </div>
        </div>
        {delta > 0 && (
          <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-700">
            +{delta} match points
          </span>
        )}
        <span className="ml-auto text-xs text-slate-400">
          Estimated fit{company ? ` for ${company}` : ""} · review before submitting
        </span>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-6 py-4">
        <div>
          <h2 className="text-base font-semibold text-slate-900">
            Tailored resume
          </h2>
          <p className="text-sm text-slate-500">
            Rephrased for this role — your real experience only. Edit anything
            before you export.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <SignedIn>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={onSave}
                disabled={saveState === "saving"}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="h-4 w-4"
                  aria-hidden="true"
                >
                  <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z" />
                  <path d="M17 21v-8H7v8M7 3v5h8" />
                </svg>
                {saveState === "saving"
                  ? "Saving…"
                  : saveState === "saved"
                    ? "Saved ✓"
                    : saveState === "error"
                      ? "Retry save"
                      : "Save this version"}
              </button>
              <span className="group relative inline-flex">
                <span
                  className="grid h-5 w-5 cursor-help place-items-center rounded-full border border-slate-300 text-[11px] font-semibold text-slate-400"
                  aria-hidden="true"
                >
                  ?
                </span>
                <span className="pointer-events-none absolute right-0 top-7 z-10 w-60 rounded-lg bg-slate-900 px-3 py-2 text-xs leading-relaxed text-white opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
                  Saves this tailored version (including any edits) to your
                  account. Find it later under “My resumes.” Nothing else is
                  stored.
                </span>
              </span>
            </div>
          </SignedIn>
          <SignedOut>
            <SignInButton mode="modal">
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
              >
                Sign in to save
              </button>
            </SignInButton>
          </SignedOut>
          <button
            type="button"
            onClick={() => void exportPdf()}
            disabled={exporting}
            className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-indigo-600 to-violet-600 px-3.5 py-2 text-sm font-semibold text-white transition hover:from-indigo-500 hover:to-violet-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-4 w-4"
              aria-hidden="true"
            >
              <path d="M12 3v12M8 11l4 4 4-4" />
              <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
            </svg>
            {exporting ? "Exporting…" : "Export PDF"}
          </button>
          <button
            type="button"
            onClick={() => void copy()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-slate-800"
          >
            {copied ? (
            <>
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-4 w-4"
                aria-hidden="true"
              >
                <path d="M20 6 9 17l-5-5" />
              </svg>
              Copied
            </>
          ) : (
            <>
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-4 w-4"
                aria-hidden="true"
              >
                <rect x="9" y="9" width="13" height="13" rx="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
              Copy as Markdown
            </>
          )}
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-slate-100 px-6 pt-3">
        <div className="inline-flex gap-1 text-sm">
          {(
            [
              ["preview", "Preview"],
              ["diff", "Changes (diff)"],
              ["changes", "What changed & why"],
              ["edit", "Edit"],
            ] as [ResumeTab, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={`rounded-t-lg px-3 py-2 font-medium transition ${
                tab === key
                  ? "border-b-2 border-indigo-600 text-indigo-700"
                  : "text-slate-500 hover:text-slate-800"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="px-6 py-6">
        {tab === "preview" && <ResumeDocument resume={resume} />}
        {tab === "diff" && (
          <ResumeDiff original={originalMd} revised={revisedMd} />
        )}
        {tab === "changes" && <ChangeLogTab entries={tailored.change_log} />}
        {tab === "edit" && (
          <div>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
              <span>
                Edits here update the preview, copy, and PDF export instantly —
                no re-run needed.
              </span>
              {JSON.stringify(resume) !== JSON.stringify(generatedResume) && (
                <button
                  type="button"
                  onClick={() => onChange(generatedResume)}
                  className="shrink-0 rounded-md border border-slate-300 bg-white px-2.5 py-1 font-medium text-slate-600 transition hover:text-slate-900"
                >
                  ↺ Reset to generated
                </button>
              )}
            </div>
            <ResumePreview resume={resume} onChange={onChange} />
          </div>
        )}
      </div>
    </div>
  );
}

export function ResumeDocument({ resume }: { resume: ParsedResume }) {
  const c = resume.contact;
  const contactLine = [c.email, c.phone, c.location, ...c.links]
    .filter(Boolean)
    .join(" · ");
  return (
    <article className="mx-auto max-w-2xl text-slate-800">
      {c.name && (
        <h1 className="text-2xl font-bold text-slate-900">{c.name}</h1>
      )}
      {contactLine && (
        <p className="mt-1 text-sm text-slate-500">{contactLine}</p>
      )}

      {resume.summary && (
        <DocSection title="Summary">
          <p className="text-sm leading-relaxed">{resume.summary}</p>
        </DocSection>
      )}

      {resume.experience.length > 0 && (
        <DocSection title="Experience">
          <div className="space-y-4">
            {resume.experience.map((e, i) => (
              <div key={i}>
                <div className="flex items-baseline justify-between gap-3">
                  <h4 className="text-sm font-semibold text-slate-900">
                    {[e.title, e.company].filter(Boolean).join(" — ")}
                  </h4>
                  {e.dates && (
                    <span className="shrink-0 text-xs text-slate-500">
                      {e.dates}
                    </span>
                  )}
                </div>
                <ul className="mt-1.5 list-disc space-y-1 pl-5 text-sm leading-relaxed text-slate-700">
                  {e.bullets.map((b, j) => (
                    <li key={j}>{b}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </DocSection>
      )}

      {resume.projects.length > 0 && (
        <DocSection title="Projects">
          <div className="space-y-4">
            {resume.projects.map((p, i) => (
              <div key={i}>
                <h4 className="text-sm font-semibold text-slate-900">
                  {p.name}
                </h4>
                {p.description && (
                  <p className="mt-0.5 text-sm text-slate-700">
                    {p.description}
                  </p>
                )}
                <ul className="mt-1.5 list-disc space-y-1 pl-5 text-sm leading-relaxed text-slate-700">
                  {p.bullets.map((b, j) => (
                    <li key={j}>{b}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </DocSection>
      )}

      {resume.skills.length > 0 && (
        <DocSection title="Skills">
          <p className="text-sm leading-relaxed text-slate-700">
            {resume.skills.join(" · ")}
          </p>
        </DocSection>
      )}

      {resume.education.length > 0 && (
        <DocSection title="Education">
          <div className="space-y-2">
            {resume.education.map((ed, i) => (
              <div
                key={i}
                className="flex items-baseline justify-between gap-3"
              >
                <h4 className="text-sm font-semibold text-slate-900">
                  {[ed.degree, ed.school].filter(Boolean).join(" — ")}
                </h4>
                {ed.dates && (
                  <span className="shrink-0 text-xs text-slate-500">
                    {ed.dates}
                  </span>
                )}
              </div>
            ))}
          </div>
        </DocSection>
      )}
    </article>
  );
}

function DocSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-6">
      <h3 className="mb-2 border-b border-slate-200 pb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
        {title}
      </h3>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Change log
// ---------------------------------------------------------------------------

function ChangeLogTab({ entries }: { entries: ChangeLogEntry[] }) {
  if (entries.length === 0) {
    return (
      <p className="text-sm text-slate-400">
        No line-level changes were recorded for this rewrite.
      </p>
    );
  }
  return (
    <div className="space-y-5">
      <p className="text-sm text-slate-500">
        Every edit, with the original for comparison.
      </p>
      {entries.map((c, i) => (
        <div key={i}>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="rounded bg-indigo-50 px-2 py-0.5 text-xs font-semibold text-indigo-700">
              {c.section || "Edit"}
            </span>
            <span className="text-xs text-slate-500">{c.reason}</span>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-lg border border-rose-100 bg-rose-50/50 p-3">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-rose-400">
                Original
              </div>
              <p className="text-sm text-slate-600">{c.original || "—"}</p>
            </div>
            <div className="rounded-lg border border-emerald-100 bg-emerald-50/50 p-3">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-emerald-500">
                Revised
              </div>
              <p className="text-sm text-slate-700">{c.revised || "—"}</p>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Disclaimer
// ---------------------------------------------------------------------------

function Disclaimer() {
  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="mt-0.5 h-4 w-4 shrink-0"
        aria-hidden="true"
      >
        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
        <path d="M12 9v4M12 17h.01" />
      </svg>
      <span>
        All edits are rephrasings of your real experience — review before
        submitting.
      </span>
    </div>
  );
}
