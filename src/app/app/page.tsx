"use client";

import { useCallback, useRef, useState } from "react";
import Link from "next/link";
import { Logo } from "@/components/Logo";
import { ResumePreview } from "@/components/ResumePreview";
import { JobDescriptionPanel } from "@/components/JobDescriptionPanel";
import { ResultsView } from "@/components/ResultsView";
import { normalizeResume, type ParsedResume } from "@/lib/resume";
import type { ParsedJD } from "@/lib/jd";
import {
  normalizeGapAnalysis,
  normalizeTailorResult,
  type GapAnalysis,
  type TailorResult,
} from "@/lib/analysis";

const MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5MB
const ACCEPTED_EXT = [".pdf", ".docx"];
const ACCEPTED_MIME = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

type ParseStatus = "idle" | "parsing" | "ready" | "error";

function isAcceptedFile(file: File): boolean {
  const name = file.name.toLowerCase();
  const extOk = ACCEPTED_EXT.some((ext) => name.endsWith(ext));
  const mimeOk = ACCEPTED_MIME.includes(file.type);
  return extOk && (mimeOk || file.type === "");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function parseErrorMessage(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: string };
    if (data?.error) return data.error;
  } catch {
    // ignore
  }
  return `Parsing failed (${res.status}).`;
}

export default function WorkspacePage() {
  // Resume source + parse state
  const [sourceLabel, setSourceLabel] = useState<string | null>(null);
  const [status, setStatus] = useState<ParseStatus>("idle");
  const [parseError, setParseError] = useState<string | null>(null);
  const [resume, setResume] = useState<ParsedResume | null>(null);

  // Upload UI
  const [fileError, setFileError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [textMode, setTextMode] = useState(false);
  const [pastedText, setPastedText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Extra info + JD
  const [extraInfo, setExtraInfo] = useState("");
  const [parsedJd, setParsedJd] = useState<ParsedJD | null>(null);

  const handleJdChange = useCallback((_rawText: string, jd: ParsedJD | null) => {
    setParsedJd(jd);
  }, []);

  // Analyze + tailor pipeline
  const [runPhase, setRunPhase] = useState<
    "idle" | "analyzing" | "tailoring" | "error"
  >("idle");
  const [runError, setRunError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<GapAnalysis | null>(null);
  const [tailored, setTailored] = useState<TailorResult | null>(null);

  const runParse = useCallback(async (body: FormData, label: string) => {
    setStatus("parsing");
    setParseError(null);
    setSourceLabel(label);
    try {
      const res = await fetch("/api/parse-resume", {
        method: "POST",
        body,
      });
      if (!res.ok) {
        setParseError(await parseErrorMessage(res));
        setStatus("error");
        return;
      }
      const data = (await res.json()) as { resume: unknown };
      setResume(normalizeResume(data.resume));
      setStatus("ready");
    } catch {
      setParseError("Network error while parsing. Please try again.");
      setStatus("error");
    }
  }, []);

  const acceptFile = useCallback(
    (incoming: File | undefined | null) => {
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
      const body = new FormData();
      body.set("file", incoming);
      void runParse(body, incoming.name);
    },
    [runParse],
  );

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsDragging(false);
      acceptFile(e.dataTransfer.files?.[0]);
    },
    [acceptFile],
  );

  const submitPastedText = useCallback(() => {
    if (pastedText.trim().length < 30) {
      setParseError("Please paste a bit more resume text (at least a few lines).");
      setStatus("error");
      setSourceLabel("Pasted text");
      return;
    }
    const body = new FormData();
    body.set("text", pastedText);
    void runParse(body, "Pasted text");
  }, [pastedText, runParse]);

  const startOver = useCallback(() => {
    setResume(null);
    setStatus("idle");
    setParseError(null);
    setSourceLabel(null);
    setFileError(null);
    setTextMode(false);
    setPastedText("");
    if (inputRef.current) inputRef.current.value = "";
  }, []);

  const runAnalyzeTailor = useCallback(async () => {
    if (!resume || !parsedJd) return;
    setRunError(null);
    setAnalysis(null);
    setTailored(null);

    const payload = {
      structuredResume: resume,
      structuredJD: parsedJd,
      extraInfo,
    };

    try {
      // 1) Analyze fit
      setRunPhase("analyzing");
      const aRes = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!aRes.ok) {
        setRunError(await parseErrorMessage(aRes));
        setRunPhase("error");
        return;
      }
      const aData = (await aRes.json()) as { analysis: unknown };
      const gap = normalizeGapAnalysis(aData.analysis);
      setAnalysis(gap);

      // 2) Tailor resume using the gap analysis
      setRunPhase("tailoring");
      const tRes = await fetch("/api/tailor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, analysis: gap }),
      });
      if (!tRes.ok) {
        setRunError(await parseErrorMessage(tRes));
        setRunPhase("error");
        return;
      }
      const tData = (await tRes.json()) as { tailored: unknown };
      setTailored(normalizeTailorResult(tData.tailored));
      setRunPhase("idle");
    } catch {
      setRunError("Network error. Please try again.");
      setRunPhase("error");
    }
  }, [resume, parsedJd, extraInfo]);

  const backToInputs = useCallback(() => {
    setAnalysis(null);
    setTailored(null);
    setRunPhase("idle");
    setRunError(null);
  }, []);

  const canAnalyze = resume !== null && parsedJd !== null;
  const isRunning = runPhase === "analyzing" || runPhase === "tailoring";

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
            <Link
              href="/"
              className="font-medium text-slate-600 hover:text-slate-900"
            >
              ← Home
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-8">
        {analysis && tailored ? (
          <ResultsView
            analysis={analysis}
            tailored={tailored}
            onBack={backToInputs}
          />
        ) : (
          <>
            <div className="mb-8">
              <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
                Tailor your resume
              </h1>
              <p className="mt-1 text-sm text-slate-600">
                Add your resume and the job description, then let career-path do
                the rest.
              </p>
            </div>

            <div className="grid gap-6 lg:grid-cols-2">
          {/* LEFT: Resume + extra info */}
          <section className="flex flex-col gap-6">
            <Panel
              step="1"
              title="Your resume"
              subtitle="PDF or DOCX, up to 5MB — we extract and structure it for you."
            >
              {status === "ready" && resume ? (
                <ParsedHeader label={sourceLabel} onStartOver={startOver} />
              ) : status === "parsing" ? (
                <ParsingState label={sourceLabel} />
              ) : (
                <UploadArea
                  inputRef={inputRef}
                  isDragging={isDragging}
                  setIsDragging={setIsDragging}
                  onDrop={onDrop}
                  onPick={acceptFile}
                  fileError={fileError}
                  parseError={status === "error" ? parseError : null}
                  textMode={textMode}
                  setTextMode={setTextMode}
                  pastedText={pastedText}
                  setPastedText={setPastedText}
                  onSubmitText={submitPastedText}
                />
              )}

              {status === "ready" && resume && (
                <div className="mt-5 border-t border-slate-100 pt-5">
                  <ResumePreview resume={resume} onChange={setResume} />
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
              subtitle="Paste a link (or fall back to text / screenshots) and we structure it."
            >
              <JobDescriptionPanel onChange={handleJdChange} />
            </Panel>
          </section>
        </div>

            {/* Action bar */}
            <div className="mt-8 flex flex-col items-center gap-3 border-t border-slate-200 pt-8">
              <button
                type="button"
                onClick={() => void runAnalyzeTailor()}
                disabled={!canAnalyze || isRunning}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-indigo-600 to-violet-600 px-6 py-3.5 text-sm font-semibold text-white shadow-sm transition hover:from-indigo-500 hover:to-violet-500 disabled:cursor-not-allowed disabled:from-slate-300 disabled:to-slate-300 disabled:text-slate-500 disabled:shadow-none sm:w-auto sm:min-w-72"
              >
                {isRunning ? (
                  <svg
                    className="h-4 w-4 animate-spin"
                    viewBox="0 0 24 24"
                    fill="none"
                    aria-hidden="true"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4z"
                    />
                  </svg>
                ) : (
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
                )}
                {runPhase === "analyzing"
                  ? "Analyzing fit…"
                  : runPhase === "tailoring"
                    ? "Tailoring resume…"
                    : "Analyze & Tailor"}
              </button>
              <p className="text-xs text-slate-500">
                {isRunning
                  ? "This can take up to a minute."
                  : canAnalyze
                    ? "Ready when you are."
                    : resume === null
                      ? "Add your resume to continue."
                      : "Add a job description to continue."}
              </p>
              {runPhase === "error" && runError && (
                <p className="flex items-center gap-1.5 text-sm text-red-600">
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
                  {runError}
                </p>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Resume panel states
// ---------------------------------------------------------------------------

function UploadArea({
  inputRef,
  isDragging,
  setIsDragging,
  onDrop,
  onPick,
  fileError,
  parseError,
  textMode,
  setTextMode,
  pastedText,
  setPastedText,
  onSubmitText,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  isDragging: boolean;
  setIsDragging: (v: boolean) => void;
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void;
  onPick: (f: File | undefined | null) => void;
  fileError: string | null;
  parseError: string | null;
  textMode: boolean;
  setTextMode: (v: boolean) => void;
  pastedText: string;
  setPastedText: (v: string) => void;
  onSubmitText: () => void;
}) {
  return (
    <>
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
          onChange={(e) => onPick(e.target.files?.[0])}
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
          <span className="text-indigo-600">Click to upload</span> or drag &amp;
          drop
        </p>
        <p className="mt-1 text-xs text-slate-500">PDF or DOCX · max 5MB</p>
      </div>

      {fileError && <ErrorLine text={fileError} />}
      {parseError && <ErrorLine text={parseError} />}

      {/* Scanned-PDF fallback */}
      <div className="mt-3 text-center">
        <button
          type="button"
          onClick={() => setTextMode(!textMode)}
          className="text-xs font-medium text-slate-500 underline-offset-2 hover:text-slate-700 hover:underline"
        >
          {textMode
            ? "Hide text paste"
            : "Scanned PDF or upload trouble? Paste resume as text"}
        </button>
      </div>

      {textMode && (
        <div className="mt-3">
          <textarea
            value={pastedText}
            onChange={(e) => setPastedText(e.target.value)}
            placeholder="Paste your full resume text here…"
            rows={8}
            className="w-full resize-y rounded-xl border border-slate-300 bg-white px-3.5 py-3 text-sm text-slate-800 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
          />
          <button
            type="button"
            onClick={onSubmitText}
            disabled={pastedText.trim() === ""}
            className="mt-2 w-full rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            Parse pasted text
          </button>
        </div>
      )}
    </>
  );
}

function ParsingState({ label }: { label: string | null }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-slate-200 bg-slate-50 px-6 py-12 text-center">
      <svg
        className="h-7 w-7 animate-spin text-indigo-600"
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
      >
        <circle
          className="opacity-25"
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth="4"
        />
        <path
          className="opacity-75"
          fill="currentColor"
          d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4z"
        />
      </svg>
      <p className="mt-3 text-sm font-medium text-slate-700">
        Reading and structuring your resume…
      </p>
      {label && <p className="mt-1 text-xs text-slate-500">{label}</p>}
    </div>
  );
}

function ParsedHeader({
  label,
  onStartOver,
}: {
  label: string | null;
  onStartOver: () => void;
}) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-emerald-100 text-emerald-700">
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
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-slate-800">
            Parsed — review &amp; edit below
          </p>
          {label && <p className="truncate text-xs text-slate-500">{label}</p>}
        </div>
      </div>
      <button
        type="button"
        onClick={onStartOver}
        className="ml-3 shrink-0 rounded-md px-2.5 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-white"
      >
        Start over
      </button>
    </div>
  );
}

function ErrorLine({ text }: { text: string }) {
  return (
    <p className="mt-3 flex items-start gap-1.5 text-sm text-red-600">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        className="mt-0.5 h-4 w-4 shrink-0"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="10" />
        <path d="M12 8v4M12 16h.01" />
      </svg>
      {text}
    </p>
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
