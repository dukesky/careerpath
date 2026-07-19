"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { normalizeJD, type ParsedJD } from "@/lib/jd";

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const ACCEPTED_IMAGE_MIME = ["image/png", "image/jpeg", "image/jpg"];

type FallbackTab = "paste" | "screenshots";

interface ImageItem {
  id: number;
  file: File;
  preview: string;
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: string };
    if (data?.error) return data.error;
  } catch {
    // ignore
  }
  return `Request failed (${res.status}).`;
}

export function JobDescriptionPanel({
  onChange,
}: {
  onChange: (rawText: string, jd: ParsedJD | null, sourceUrl?: string) => void;
}) {
  // URL (primary)
  const [url, setUrl] = useState("");
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [showFallbacks, setShowFallbacks] = useState(false);
  const [tab, setTab] = useState<FallbackTab>("paste");

  // Paste
  const [pasteText, setPasteText] = useState("");

  // Screenshots + OCR
  const [images, setImages] = useState<ImageItem[]>([]);
  const [imageError, setImageError] = useState<string | null>(null);
  const [ocrRunning, setOcrRunning] = useState(false);
  const [ocrError, setOcrError] = useState<string | null>(null);
  const [ocrText, setOcrText] = useState("");
  const imgInputRef = useRef<HTMLInputElement>(null);
  const nextImageId = useRef(0);

  // Parse
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [jd, setJd] = useState<ParsedJD | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(true);

  // Revoke object URLs on unmount.
  useEffect(() => {
    return () => {
      images.forEach((i) => URL.revokeObjectURL(i.preview));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doParse = useCallback(
    async (text: string, sourceUrl?: string) => {
      setParsing(true);
      setParseError(null);
      try {
        const res = await fetch("/api/parse-jd", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
        if (!res.ok) {
          setParseError(await errorMessage(res));
          return;
        }
        const data = (await res.json()) as { jd: unknown };
        const parsed = normalizeJD(data.jd);
        setJd(parsed);
        setSummaryOpen(true);
        onChange(text, parsed, sourceUrl);
      } catch {
        setParseError("Network error while parsing the job description.");
      } finally {
        setParsing(false);
      }
    },
    [onChange],
  );

  const fetchUrl = useCallback(async () => {
    if (url.trim() === "") {
      setFetchError("Please enter a URL.");
      return;
    }
    setFetching(true);
    setFetchError(null);
    try {
      const res = await fetch("/api/fetch-jd", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });
      const data = (await res.json()) as {
        ok: boolean;
        text?: string;
        reason?: string;
      };
      if (data.ok && data.text) {
        setFetching(false);
        await doParse(data.text, url.trim());
        return;
      }
      setFetchError(data.reason ?? "Could not fetch that URL.");
      setShowFallbacks(true);
    } catch {
      setFetchError("Could not reach that URL.");
      setShowFallbacks(true);
    } finally {
      setFetching(false);
    }
  }, [url, doParse]);

  const addImages = useCallback(
    (fileList: FileList | null) => {
      if (!fileList) return;
      setImageError(null);
      setImages((current) => {
        const next = [...current];
        for (const file of Array.from(fileList)) {
          if (next.length >= MAX_IMAGES) {
            setImageError(`You can upload at most ${MAX_IMAGES} screenshots.`);
            break;
          }
          if (!ACCEPTED_IMAGE_MIME.includes(file.type)) {
            setImageError("Only PNG and JPG images are supported.");
            continue;
          }
          if (file.size > MAX_IMAGE_BYTES) {
            setImageError(`Each image must be under 4MB (${file.name}).`);
            continue;
          }
          next.push({
            id: nextImageId.current++,
            file,
            preview: URL.createObjectURL(file),
          });
        }
        return next;
      });
    },
    [],
  );

  const removeImage = useCallback((id: number) => {
    setImages((current) => {
      const target = current.find((i) => i.id === id);
      if (target) URL.revokeObjectURL(target.preview);
      return current.filter((i) => i.id !== id);
    });
  }, []);

  const runOcr = useCallback(async () => {
    if (images.length === 0) return;
    setOcrRunning(true);
    setOcrError(null);
    try {
      const body = new FormData();
      images.forEach((i) => body.append("images", i.file));
      const res = await fetch("/api/ocr-jd", { method: "POST", body });
      if (!res.ok) {
        setOcrError(await errorMessage(res));
        return;
      }
      const data = (await res.json()) as { text: string };
      setOcrText(data.text);
    } catch {
      setOcrError("Network error during OCR.");
    } finally {
      setOcrRunning(false);
    }
  }, [images]);

  const startOver = useCallback(() => {
    images.forEach((i) => URL.revokeObjectURL(i.preview));
    setImages([]);
    setUrl("");
    setFetchError(null);
    setShowFallbacks(false);
    setPasteText("");
    setOcrText("");
    setOcrError(null);
    setImageError(null);
    setParseError(null);
    setJd(null);
    onChange("", null);
  }, [images, onChange]);

  // ----- Rendered: structured summary once parsed -----
  if (jd) {
    return (
      <JdSummary
        jd={jd}
        open={summaryOpen}
        onToggle={() => setSummaryOpen((o) => !o)}
        onStartOver={startOver}
      />
    );
  }

  // ----- Rendered: input flow -----
  return (
    <div>
      {/* URL — primary */}
      <label className="block text-sm font-medium text-slate-700">
        Job posting URL
      </label>
      <div className="mt-1.5 flex gap-2">
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void fetchUrl();
            }
          }}
          placeholder="https://company.com/careers/senior-engineer"
          className="min-w-0 flex-1 rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-800 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
        />
        <button
          type="button"
          onClick={() => void fetchUrl()}
          disabled={fetching || parsing}
          className="shrink-0 rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          {fetching ? "Fetching…" : parsing ? "Parsing…" : "Fetch"}
        </button>
      </div>

      {fetchError && <ErrorLine text={fetchError} />}
      {parseError && <ErrorLine text={parseError} />}

      {!showFallbacks && !fetching && !parsing && (
        <div className="mt-2 space-y-1">
          <p className="text-xs text-slate-400">
            Works with LinkedIn, Greenhouse, Lever, Ashby &amp; most job boards.
          </p>
          <button
            type="button"
            onClick={() => setShowFallbacks(true)}
            className="text-xs font-medium text-slate-500 underline-offset-2 hover:text-slate-700 hover:underline"
          >
            Site blocks fetching? Paste text or upload screenshots instead
          </button>
        </div>
      )}

      {(parsing || fetching) && (
        <div className="mt-3 flex items-center gap-2 text-sm text-slate-500">
          <Spinner /> Working on the job description…
        </div>
      )}

      {showFallbacks && (
        <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50/60 p-4">
          {/* Tabs */}
          <div className="mb-3 inline-flex rounded-lg border border-slate-200 bg-white p-0.5 text-sm">
            <TabButton
              active={tab === "paste"}
              onClick={() => setTab("paste")}
              label="Paste text"
            />
            <TabButton
              active={tab === "screenshots"}
              onClick={() => setTab("screenshots")}
              label="Upload screenshots"
            />
          </div>

          {tab === "paste" ? (
            <div>
              <textarea
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                placeholder="Paste the full job description here…"
                rows={10}
                className="w-full resize-y rounded-xl border border-slate-300 bg-white px-3.5 py-3 text-sm text-slate-800 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
              />
              <button
                type="button"
                onClick={() => void doParse(pasteText)}
                disabled={pasteText.trim() === "" || parsing}
                className="mt-2 w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-slate-300"
              >
                {parsing ? "Parsing…" : "Parse pasted JD"}
              </button>
            </div>
          ) : (
            <div>
              {/* Multi-file dropzone */}
              <div
                role="button"
                tabIndex={0}
                onClick={() => imgInputRef.current?.click()}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    imgInputRef.current?.click();
                  }
                }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  addImages(e.dataTransfer.files);
                }}
                className="flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-slate-300 bg-white px-6 py-6 text-center transition hover:border-indigo-300 hover:bg-slate-50"
              >
                <input
                  ref={imgInputRef}
                  type="file"
                  accept="image/png,image/jpeg"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    addImages(e.target.files);
                    e.target.value = "";
                  }}
                />
                <p className="text-sm font-medium text-slate-700">
                  <span className="text-indigo-600">Add screenshots</span> or drag
                  &amp; drop
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  PNG or JPG · up to {MAX_IMAGES} images · 4MB each
                </p>
              </div>

              {imageError && <ErrorLine text={imageError} />}

              {images.length > 0 && (
                <div className="mt-3 grid grid-cols-4 gap-2">
                  {images.map((img, idx) => (
                    <div
                      key={img.id}
                      className="group relative aspect-[3/4] overflow-hidden rounded-lg border border-slate-200 bg-white"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={img.preview}
                        alt={`Screenshot ${idx + 1}`}
                        className="h-full w-full object-cover"
                      />
                      <span className="absolute left-1 top-1 rounded bg-slate-900/70 px-1.5 py-0.5 text-[10px] font-medium text-white">
                        {idx + 1}
                      </span>
                      <button
                        type="button"
                        onClick={() => removeImage(img.id)}
                        className="absolute right-1 top-1 rounded bg-white/90 p-1 text-slate-600 opacity-0 transition group-hover:opacity-100 hover:text-red-600"
                        aria-label={`Remove screenshot ${idx + 1}`}
                      >
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          strokeLinecap="round"
                          className="h-3 w-3"
                          aria-hidden="true"
                        >
                          <path d="M18 6 6 18M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {images.length > 0 && !ocrText && (
                <button
                  type="button"
                  onClick={() => void runOcr()}
                  disabled={ocrRunning}
                  className="mt-3 w-full rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
                >
                  {ocrRunning
                    ? "Reading screenshots…"
                    : `Extract text from ${images.length} image${images.length > 1 ? "s" : ""}`}
                </button>
              )}

              {ocrError && <ErrorLine text={ocrError} />}

              {/* OCR confirmation step */}
              {ocrText && (
                <div className="mt-3">
                  <label className="mb-1 block text-xs font-medium text-slate-500">
                    Extracted text — review &amp; edit before parsing
                  </label>
                  <textarea
                    value={ocrText}
                    onChange={(e) => setOcrText(e.target.value)}
                    rows={10}
                    className="w-full resize-y rounded-xl border border-slate-300 bg-white px-3.5 py-3 text-sm text-slate-800 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                  />
                  <button
                    type="button"
                    onClick={() => void doParse(ocrText)}
                    disabled={ocrText.trim() === "" || parsing}
                    className="mt-2 w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-slate-300"
                  >
                    {parsing ? "Parsing…" : "Looks good — parse this text"}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Structured JD summary (collapsible)
// ---------------------------------------------------------------------------

function JdSummary({
  jd,
  open,
  onToggle,
  onStartOver,
}: {
  jd: ParsedJD;
  open: boolean;
  onToggle: () => void;
  onStartOver: () => void;
}) {
  const title =
    [jd.role_title, jd.company].filter(Boolean).join(" · ") ||
    "Job description parsed";

  return (
    <div className="rounded-xl border border-emerald-200 bg-emerald-50/60">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <button
          type="button"
          onClick={onToggle}
          className="flex min-w-0 items-center gap-2 text-left"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`h-4 w-4 shrink-0 text-slate-500 transition ${open ? "rotate-90" : ""}`}
            aria-hidden="true"
          >
            <path d="m9 18 6-6-6-6" />
          </svg>
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold text-slate-900">
              {title}
            </span>
            {jd.seniority_level && (
              <span className="block text-xs text-slate-500">
                {jd.seniority_level}
              </span>
            )}
          </span>
        </button>
        <button
          type="button"
          onClick={onStartOver}
          className="shrink-0 rounded-md px-2.5 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-white"
        >
          Start over
        </button>
      </div>

      {open && (
        <div className="space-y-4 border-t border-emerald-200/70 px-4 py-4">
          <ChipList label="Must-have requirements" items={jd.must_have_requirements} />
          <ChipList label="Nice to have" items={jd.nice_to_have} />
          <ChipList label="Key responsibilities" items={jd.key_responsibilities} />
          <ChipList label="Keywords" items={jd.keywords} chips />
          {jd.company_context_hints && (
            <div>
              <SummaryLabel>Company context</SummaryLabel>
              <p className="mt-1 text-sm text-slate-700">
                {jd.company_context_hints}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ChipList({
  label,
  items,
  chips = false,
}: {
  label: string;
  items: string[];
  chips?: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <div>
      <SummaryLabel>{label}</SummaryLabel>
      {chips ? (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {items.map((it, i) => (
            <span
              key={i}
              className="rounded-md bg-white px-2 py-0.5 text-xs font-medium text-slate-600 ring-1 ring-slate-200"
            >
              {it}
            </span>
          ))}
        </div>
      ) : (
        <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-slate-700">
          {items.map((it, i) => (
            <li key={i}>{it}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SummaryLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Small shared bits
// ---------------------------------------------------------------------------

function TabButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md px-3 py-1.5 font-medium transition ${
        active
          ? "bg-slate-900 text-white"
          : "text-slate-600 hover:text-slate-900"
      }`}
    >
      {label}
    </button>
  );
}

function Spinner() {
  return (
    <svg
      className="h-4 w-4 animate-spin text-indigo-600"
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
