"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Logo } from "@/components/Logo";
import { ResumePreview } from "@/components/ResumePreview";
import { JobDescriptionPanel } from "@/components/JobDescriptionPanel";
import { ResultsView } from "@/components/ResultsView";
import { WaitlistModal } from "@/components/WaitlistModal";
import { apiHeaders, captureAccessCode, setAccessCode } from "@/lib/anon";
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
  const [runPhase, setRunPhase] = useState<"idle" | "running" | "error">(
    "idle",
  );
  const [runError, setRunError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<GapAnalysis | null>(null);
  const [tailored, setTailored] = useState<TailorResult | null>(null);
  // The resume exactly as generated — kept so edits can be reverted.
  const [generatedTailored, setGeneratedTailored] =
    useState<TailorResult | null>(null);
  // Which view is showing. Results are kept when switching back to inputs.
  const [view, setView] = useState<"input" | "results">("input");

  // Model quality (fast = Haiku, quality = Sonnet)
  const [quality, setQuality] = useState<"fast" | "quality">("quality");
  // Whether the tailored resume should include a summary section.
  const [includeSummary, setIncludeSummary] = useState(true);

  // Anonymous free-usage quota
  const [remaining, setRemaining] = useState<number | null>(null);
  const [unlimited, setUnlimited] = useState(false);
  const [showWaitlist, setShowWaitlist] = useState(false);

  // Beta code entry
  const [showCodeInput, setShowCodeInput] = useState(false);
  const [codeInput, setCodeInput] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);

  const refreshQuota = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch("/api/quota", { headers: apiHeaders(false) });
      const d = (await res.json()) as {
        remaining: number | null;
        unlimited?: boolean;
      };
      if (d.unlimited) {
        setUnlimited(true);
        return true;
      }
      if (typeof d.remaining === "number") setRemaining(d.remaining);
      return false;
    } catch {
      return false;
    }
  }, []);

  useEffect(() => {
    captureAccessCode(); // persist ?code= before the quota fetch reads it
    void refreshQuota();
  }, [refreshQuota]);

  const applyCode = useCallback(async () => {
    const code = codeInput.trim();
    if (!code) return;
    setAccessCode(code);
    setCodeError(null);
    const ok = await refreshQuota();
    if (ok) {
      setShowCodeInput(false);
      setCodeInput("");
    } else {
      setCodeError("That code isn't valid.");
    }
  }, [codeInput, refreshQuota]);

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

    // Out of free tailors — go straight to the waitlist.
    if (remaining !== null && remaining <= 0) {
      setShowWaitlist(true);
      return;
    }

    setRunError(null);
    setAnalysis(null);
    setTailored(null);
    setRunPhase("running");

    const payload = {
      structuredResume: resume,
      structuredJD: parsedJd,
      extraInfo,
      quality,
      includeSummary,
    };

    try {
      // Analyze and tailor run concurrently — tailor doesn't need the gap
      // analysis (it has the structured JD), which roughly halves wall-clock.
      const [aRes, tRes] = await Promise.all([
        fetch("/api/analyze", {
          method: "POST",
          headers: apiHeaders(),
          body: JSON.stringify(payload),
        }),
        fetch("/api/tailor", {
          method: "POST",
          headers: apiHeaders(),
          body: JSON.stringify(payload),
        }),
      ]);

      // Quota is gated on the tailor route.
      if (tRes.status === 402) {
        setRemaining(0);
        setShowWaitlist(true);
        setRunPhase("idle");
        return;
      }
      if (!tRes.ok) {
        setRunError(await parseErrorMessage(tRes));
        setRunPhase("error");
        return;
      }
      if (!aRes.ok) {
        setRunError(await parseErrorMessage(aRes));
        setRunPhase("error");
        return;
      }

      const aData = (await aRes.json()) as { analysis: unknown };
      const tData = (await tRes.json()) as {
        tailored: unknown;
        remaining?: number;
      };
      const generated = normalizeTailorResult(tData.tailored);
      setAnalysis(normalizeGapAnalysis(aData.analysis));
      setTailored(generated);
      setGeneratedTailored(generated); // snapshot for "revert edits"
      if (typeof tData.remaining === "number") setRemaining(tData.remaining);
      setRunPhase("idle");
      setView("results");
    } catch {
      setRunError("Network error. Please try again.");
      setRunPhase("error");
    }
  }, [resume, parsedJd, extraInfo, quality, includeSummary, remaining]);

  // Switch back to the input view but KEEP the generated results so the user
  // can return to them without re-running the LLM.
  const backToInputs = useCallback(() => {
    setView("input");
    setRunError(null);
  }, []);

  const canAnalyze = resume !== null && parsedJd !== null;
  const isRunning = runPhase === "running";

  return (
    <div className="flex min-h-full flex-col bg-[#F7F7FB]">
      <header className="border-b border-[#EDEDF3] bg-white/85 backdrop-blur">
        <div className="mx-auto flex w-full max-w-7xl items-center justify-between px-6 py-4">
          <Logo />
          <div className="flex items-center gap-5 text-sm text-slate-500">
            <span className="hidden items-center gap-2 sm:inline-flex">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              Nothing stored, nothing saved
            </span>
            {unlimited ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-[#0E1220] px-3 py-1.5 text-xs font-semibold text-white">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                Beta · unlimited
              </span>
            ) : (
              remaining !== null &&
              (remaining > 0 ? (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-[#F1ECFE] px-3 py-1.5 text-xs font-semibold text-[#6D28D9]">
                  {remaining} free tailor{remaining === 1 ? "" : "s"} left
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowWaitlist(true)}
                  className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700 transition hover:bg-amber-100"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                  No free tailors left — get credits
                </button>
              ))
            )}

            {!unlimited &&
              (showCodeInput ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void applyCode();
                  }}
                  className="flex items-center gap-1.5"
                >
                  <input
                    type="text"
                    value={codeInput}
                    onChange={(e) => {
                      setCodeInput(e.target.value);
                      setCodeError(null);
                    }}
                    autoFocus
                    placeholder="Beta code"
                    className={`w-28 rounded-full border px-3 py-1 text-xs focus:outline-none focus:ring-2 ${
                      codeError
                        ? "border-rose-300 focus:ring-rose-100"
                        : "border-slate-300 focus:border-[#7C3AED] focus:ring-[#EDE7FC]"
                    }`}
                  />
                  <button
                    type="submit"
                    className="rounded-full bg-[#0E1220] px-2.5 py-1 text-xs font-semibold text-white transition hover:bg-[#1c2236]"
                  >
                    Apply
                  </button>
                  {codeError && (
                    <span className="text-xs text-rose-500">{codeError}</span>
                  )}
                </form>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowCodeInput(true)}
                  className="text-xs font-medium text-slate-400 transition hover:text-slate-600"
                >
                  Have a beta code?
                </button>
              ))}

            <Link
              href="/"
              className="font-medium text-slate-600 transition hover:text-slate-900"
            >
              ← Home
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-8 sm:py-11">
        {view === "results" && analysis && tailored && resume ? (
          <ResultsView
            analysis={analysis}
            tailored={tailored}
            originalResume={resume}
            generatedResume={(generatedTailored ?? tailored).resume}
            company={parsedJd?.company ?? ""}
            onTailoredResumeChange={(next) =>
              setTailored((prev) => (prev ? { ...prev, resume: next } : prev))
            }
            onBack={backToInputs}
          />
        ) : (
          <>
            {tailored && analysis && (
              <button
                type="button"
                onClick={() => setView("results")}
                className="mb-6 inline-flex items-center gap-2 rounded-xl border border-[#E7E3F5] bg-[#F5F1FE] px-4 py-2.5 text-sm font-semibold text-[#6D28D9] transition hover:bg-[#EDE7FC]"
              >
                ← Back to your tailored resume
                <span className="rounded-full bg-white/70 px-2 py-0.5 text-xs font-medium">
                  kept
                </span>
              </button>
            )}
            <div className="mb-8">
              <h1 className="font-display text-3xl font-bold tracking-tight text-[#0E1220] sm:text-[34px]">
                Tailor your resume
              </h1>
              <p className="mt-2 text-base text-[#606574]">
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
                className="w-full resize-y rounded-xl border border-slate-300 bg-white px-3.5 py-3 text-sm text-slate-800 placeholder:text-slate-400 focus:border-[#7C3AED] focus:outline-none focus:ring-2 focus:ring-[#EDE7FC]"
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
              <div className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white p-0.5 text-xs font-medium">
                <button
                  type="button"
                  onClick={() => setQuality("fast")}
                  disabled={isRunning}
                  className={`rounded-full px-3 py-1.5 transition disabled:cursor-not-allowed ${
                    quality === "fast"
                      ? "bg-[#0E1220] text-white"
                      : "text-slate-600 hover:text-slate-900"
                  }`}
                  title="Faster & cheaper — Claude Haiku 4.5"
                >
                  ⚡ Fast
                </button>
                <button
                  type="button"
                  onClick={() => setQuality("quality")}
                  disabled={isRunning}
                  className={`rounded-full px-3 py-1.5 transition disabled:cursor-not-allowed ${
                    quality === "quality"
                      ? "bg-[#0E1220] text-white"
                      : "text-slate-600 hover:text-slate-900"
                  }`}
                  title="Best results — Claude Sonnet 4.6"
                >
                  ✦ Quality
                </button>
              </div>
              <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-slate-600 select-none">
                <input
                  type="checkbox"
                  checked={includeSummary}
                  onChange={(e) => setIncludeSummary(e.target.checked)}
                  disabled={isRunning}
                  className="h-3.5 w-3.5 rounded border-slate-300 accent-[#7C3AED]"
                />
                Include a summary section
              </label>
              <button
                type="button"
                onClick={() => void runAnalyzeTailor()}
                disabled={!canAnalyze || isRunning}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-[#0E1220] px-7 py-3.5 text-sm font-semibold text-white shadow-[0_14px_30px_-12px_rgba(14,18,32,0.5)] transition hover:bg-[#1c2236] disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-500 disabled:shadow-none sm:w-auto sm:min-w-72"
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
                {isRunning ? "Analyzing & tailoring…" : "Analyze & Tailor"}
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

      <WaitlistModal
        open={showWaitlist}
        onClose={() => setShowWaitlist(false)}
      />
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
        className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border-[1.5px] border-dashed px-6 py-10 text-center transition ${
          isDragging
            ? "border-[#7C3AED] bg-[#F5F1FE]"
            : "border-[#CFC6EC] bg-[#FBFAFF] hover:border-[#B9A9EC] hover:bg-[#F5F1FE]"
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          className="hidden"
          onChange={(e) => onPick(e.target.files?.[0])}
        />
        <span className="mb-3.5 grid h-13 w-13 place-items-center rounded-2xl bg-[#F1ECFE] text-[#7C3AED]">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-6 w-6"
            aria-hidden="true"
          >
            <path d="M12 16V5m0 0L8 9m4-4l4 4" />
            <path d="M5 15v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2" />
          </svg>
        </span>
        <p className="text-base font-medium text-[#0E1220]">
          <span className="font-semibold text-[#7C3AED]">Click to upload</span>{" "}
          or drag &amp; drop
        </p>
        <p className="mt-1.5 text-[13px] text-[#9298A8]">PDF or DOCX · max 5MB</p>
      </div>

      {fileError && <ErrorLine text={fileError} />}
      {parseError && <ErrorLine text={parseError} />}

      {/* Scanned-PDF fallback */}
      <div className="mt-3.5 text-center">
        <button
          type="button"
          onClick={() => setTextMode(!textMode)}
          className="text-[13.5px] font-medium text-slate-500 underline-offset-2 transition hover:text-[#7C3AED] hover:underline"
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
            className="w-full resize-y rounded-xl border border-slate-300 bg-white px-3.5 py-3 text-sm text-slate-800 placeholder:text-slate-400 focus:border-[#7C3AED] focus:outline-none focus:ring-2 focus:ring-[#EDE7FC]"
          />
          <button
            type="button"
            onClick={onSubmitText}
            disabled={pastedText.trim() === ""}
            className="mt-2 w-full rounded-lg bg-[#0E1220] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[#1c2236] disabled:cursor-not-allowed disabled:bg-slate-300"
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
        className="h-7 w-7 animate-spin text-[#7C3AED]"
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
    <div className="rounded-2xl border border-[#EBEBF2] bg-white p-6 shadow-sm sm:p-7">
      <div className="mb-5 flex items-start gap-3.5">
        <span className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-lg bg-[#0E1220] text-sm font-bold text-white">
          {step}
        </span>
        <div>
          <h2 className="font-display text-[19px] font-bold text-[#0E1220]">
            {title}
          </h2>
          <p className="mt-0.5 text-sm text-[#7C8092]">{subtitle}</p>
        </div>
      </div>
      {children}
    </div>
  );
}
