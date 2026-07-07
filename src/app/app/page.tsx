"use client";

import { useCallback, useRef, useState } from "react";
import Link from "next/link";
import { Logo } from "@/components/Logo";

const MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5MB
const ACCEPTED_EXT = [".pdf", ".docx"];
const ACCEPTED_MIME = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

function isAcceptedFile(file: File): boolean {
  const name = file.name.toLowerCase();
  const extOk = ACCEPTED_EXT.some((ext) => name.endsWith(ext));
  const mimeOk = ACCEPTED_MIME.includes(file.type);
  // Some browsers report an empty MIME for .docx — fall back to extension.
  return extOk && (mimeOk || file.type === "");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function WorkspacePage() {
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [extraInfo, setExtraInfo] = useState("");
  const [jdText, setJdText] = useState("");
  const [jdUrl, setJdUrl] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const acceptFile = useCallback((incoming: File | undefined | null) => {
    if (!incoming) return;
    if (!isAcceptedFile(incoming)) {
      setFileError("Unsupported file type. Please upload a PDF or DOCX.");
      return;
    }
    if (incoming.size > MAX_SIZE_BYTES) {
      setFileError(
        `That file is ${formatBytes(incoming.size)}. The limit is 5MB.`,
      );
      return;
    }
    setFileError(null);
    setFile(incoming);
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsDragging(false);
      acceptFile(e.dataTransfer.files?.[0]);
    },
    [acceptFile],
  );

  const canAnalyze = Boolean(file) && jdText.trim().length > 0;

  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b border-slate-200 bg-white/80 backdrop-blur">
        <div className="mx-auto flex w-full max-w-7xl items-center justify-between px-6 py-4">
          <Logo />
          <div className="flex items-center gap-4 text-sm text-slate-500">
            <span className="hidden items-center gap-2 sm:inline-flex">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              Nothing stored, nothing saved
            </span>
            <Link href="/" className="font-medium text-slate-600 hover:text-slate-900">
              ← Home
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-8">
        <div className="mb-8">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
            Tailor your resume
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Add your resume and the job description, then let career-path do the
            rest.
          </p>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          {/* LEFT: Resume + extra info */}
          <section className="flex flex-col gap-6">
            <Panel
              step="1"
              title="Your resume"
              subtitle="PDF or DOCX, up to 5MB."
            >
              <div
                role="button"
                tabIndex={0}
                onClick={() => inputRef.current?.click()}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    inputRef.current?.click();
                  }
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsDragging(true);
                }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={onDrop}
                className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-10 text-center transition ${
                  isDragging
                    ? "border-indigo-400 bg-indigo-50"
                    : "border-slate-300 bg-slate-50 hover:border-indigo-300 hover:bg-slate-100"
                }`}
              >
                <input
                  ref={inputRef}
                  type="file"
                  accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  className="hidden"
                  onChange={(e) => acceptFile(e.target.files?.[0])}
                />
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="h-8 w-8 text-slate-400"
                  aria-hidden="true"
                >
                  <path d="M12 15V3" />
                  <path d="m7 8 5-5 5 5" />
                  <path d="M5 21h14a2 2 0 0 0 2-2v-4" />
                </svg>
                <p className="mt-3 text-sm font-medium text-slate-700">
                  <span className="text-indigo-600">Click to upload</span> or drag
                  &amp; drop
                </p>
                <p className="mt-1 text-xs text-slate-500">PDF or DOCX · max 5MB</p>
              </div>

              {fileError && (
                <p className="mt-3 flex items-center gap-1.5 text-sm text-red-600">
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    className="h-4 w-4 shrink-0"
                    aria-hidden="true"
                  >
                    <circle cx="12" cy="12" r="10" />
                    <path d="M12 8v4M12 16h.01" />
                  </svg>
                  {fileError}
                </p>
              )}

              {file && (
                <div className="mt-3 flex items-center justify-between rounded-lg border border-slate-200 bg-white px-3 py-2.5">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-indigo-50 text-indigo-600">
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
                        <path d="M14 3v4a1 1 0 0 0 1 1h4" />
                        <path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2Z" />
                      </svg>
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-slate-800">
                        {file.name}
                      </p>
                      <p className="text-xs text-slate-500">
                        {formatBytes(file.size)}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setFile(null);
                      setFileError(null);
                      if (inputRef.current) inputRef.current.value = "";
                    }}
                    className="ml-3 shrink-0 rounded-md p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
                    aria-label="Remove file"
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
                </div>
              )}
            </Panel>

            <Panel
              step="+"
              title="Anything not on your resume?"
              subtitle="Optional — projects, skills, or context you want considered."
            >
              <textarea
                value={extraInfo}
                onChange={(e) => setExtraInfo(e.target.value)}
                placeholder="e.g. Built a side project that handles 10k req/s, led a migration to TypeScript, volunteer mentoring…"
                rows={6}
                className="w-full resize-y rounded-xl border border-slate-300 bg-white px-3.5 py-3 text-sm text-slate-800 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
              />
            </Panel>
          </section>

          {/* RIGHT: Job description */}
          <section className="flex flex-col gap-6">
            <Panel
              step="2"
              title="Job description"
              subtitle="Paste the JD text. A link is optional but helpful."
            >
              <textarea
                value={jdText}
                onChange={(e) => setJdText(e.target.value)}
                placeholder="Paste the full job description here…"
                rows={14}
                className="w-full resize-y rounded-xl border border-slate-300 bg-white px-3.5 py-3 text-sm text-slate-800 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
              />

              <label className="mt-4 block text-sm font-medium text-slate-700">
                Job posting URL{" "}
                <span className="font-normal text-slate-400">(optional)</span>
              </label>
              <input
                type="url"
                value={jdUrl}
                onChange={(e) => setJdUrl(e.target.value)}
                placeholder="https://company.com/careers/senior-engineer"
                className="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-800 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
              />
            </Panel>
          </section>
        </div>

        {/* Action bar */}
        <div className="mt-8 flex flex-col items-center gap-3 border-t border-slate-200 pt-8">
          <button
            type="button"
            disabled={!canAnalyze}
            className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-indigo-600 to-violet-600 px-6 py-3.5 text-sm font-semibold text-white shadow-sm transition hover:from-indigo-500 hover:to-violet-500 disabled:cursor-not-allowed disabled:from-slate-300 disabled:to-slate-300 disabled:text-slate-500 disabled:shadow-none sm:w-auto sm:min-w-72"
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
              <path d="M5 3v4M3 5h4M6 17v4M4 19h4" />
              <path d="M13 3 15.5 9.5 22 12l-6.5 2.5L13 21l-2.5-6.5L4 12l6.5-2.5L13 3Z" />
            </svg>
            Analyze &amp; Tailor
          </button>
          <p className="text-xs text-slate-500">
            {canAnalyze
              ? "Ready when you are."
              : "Add your resume and a job description to continue."}
          </p>
        </div>
      </main>
    </div>
  );
}

function Panel({
  step,
  title,
  subtitle,
  children,
}: {
  step: string;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="mb-4 flex items-start gap-3">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-slate-900 text-xs font-semibold text-white">
          {step}
        </span>
        <div>
          <h2 className="text-base font-semibold text-slate-900">{title}</h2>
          <p className="text-sm text-slate-500">{subtitle}</p>
        </div>
      </div>
      {children}
    </div>
  );
}
