"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  SignedIn,
  SignedOut,
  SignInButton,
  UserButton,
} from "@/components/clerk-auth";
import { Logo } from "@/components/Logo";
import { ResumeDocument } from "@/components/ResultsView";
import { normalizeResume, type ParsedResume } from "@/lib/resume";

interface SavedItem {
  id: string;
  company: string;
  roleTitle: string;
  savedAt: string;
  resume: ParsedResume;
  jdSummary: string;
  jdUrl?: string;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "job posting";
  }
}

export default function SavedResumesPage() {
  return (
    <div className="flex min-h-full flex-col bg-[#F7F7FB]">
      <header className="border-b border-[#EDEDF3] bg-white/85 backdrop-blur">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-6 py-4">
          <Logo />
          <div className="flex items-center gap-5 text-sm text-slate-500">
            <Link
              href="/app"
              className="font-medium text-slate-600 transition hover:text-slate-900"
            >
              ← Back to app
            </Link>
            <SignedIn>
              <UserButton appearance={{ elements: { avatarBox: "h-7 w-7" } }} />
            </SignedIn>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-8">
        <h1 className="font-display text-3xl font-bold tracking-tight text-[#0E1220]">
          My resumes
        </h1>
        <p className="mt-1.5 text-sm text-[#606574]">
          Versions you chose to save. Nothing else is stored.
        </p>

        <SignedOut>
          <div className="mt-8 rounded-2xl border border-slate-200 bg-white p-8 text-center">
            <p className="text-sm text-slate-600">
              Sign in to see the resume versions you&apos;ve saved.
            </p>
            <SignInButton mode="modal">
              <button
                type="button"
                className="mt-4 rounded-xl bg-[#0E1220] px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-[#1c2236]"
              >
                Sign in
              </button>
            </SignInButton>
          </div>
        </SignedOut>

        <SignedIn>
          <SavedList />
        </SignedIn>
      </main>
    </div>
  );
}

function SavedList() {
  const [items, setItems] = useState<SavedItem[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/saved");
      if (!res.ok) {
        setItems([]);
        return;
      }
      const data = (await res.json()) as { items: SavedItem[] };
      setItems(
        (data.items ?? []).map((it) => ({
          ...it,
          resume: normalizeResume(it.resume),
        })),
      );
    } catch {
      setItems([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function remove(id: string) {
    setBusyId(id);
    try {
      await fetch(`/api/saved/${id}`, { method: "DELETE" });
      setItems((prev) => (prev ? prev.filter((i) => i.id !== id) : prev));
    } finally {
      setBusyId(null);
    }
  }

  async function exportPdf(item: SavedItem) {
    const { generateResumePdf, resumePdfFilename } = await import(
      "@/lib/resume-pdf"
    );
    const blob = await generateResumePdf(item.resume);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = resumePdfFilename(item.resume.contact.name, item.company);
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  if (items === null) {
    return <p className="mt-8 text-sm text-slate-400">Loading…</p>;
  }
  if (items.length === 0) {
    return (
      <div className="mt-8 rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
        No saved resumes yet. Tailor a resume, then hit{" "}
        <span className="font-medium text-slate-700">“Save this version”</span>{" "}
        on the results page.
      </div>
    );
  }

  return (
    <div className="mt-8 space-y-4">
      {items.map((item) => {
        const title =
          [item.roleTitle, item.company].filter(Boolean).join(" · ") ||
          item.resume.contact.name ||
          "Saved resume";
        const date = item.savedAt.slice(0, 10);
        const open = openId === item.id;
        return (
          <div
            key={item.id}
            className="rounded-2xl border border-slate-200 bg-white shadow-sm"
          >
            <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-4">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-slate-900">
                  {title}
                </div>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-400">
                  <span>Saved {date}</span>
                  {item.jdUrl && (
                    <>
                      <span aria-hidden="true">·</span>
                      <a
                        href={item.jdUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 font-medium text-indigo-600 transition hover:text-indigo-500 hover:underline"
                      >
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className="h-3.5 w-3.5"
                          aria-hidden="true"
                        >
                          <path d="M10 13a5 5 0 0 0 7.07 0l1.41-1.41a5 5 0 0 0-7.07-7.07L10 5.5" />
                          <path d="M14 11a5 5 0 0 0-7.07 0L5.5 12.4a5 5 0 0 0 7.07 7.07L14 18.5" />
                        </svg>
                        {hostOf(item.jdUrl)}
                      </a>
                    </>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setOpenId(open ? null : item.id)}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-50"
                >
                  {open ? "Hide" : "Preview"}
                </button>
                <button
                  type="button"
                  onClick={() => void exportPdf(item)}
                  className="rounded-lg bg-[#0E1220] px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-[#1c2236]"
                >
                  Export PDF
                </button>
                <button
                  type="button"
                  onClick={() => void remove(item.id)}
                  disabled={busyId === item.id}
                  className="rounded-lg p-1.5 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50"
                  aria-label="Delete"
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    className="h-4 w-4"
                    aria-hidden="true"
                  >
                    <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
                  </svg>
                </button>
              </div>
            </div>
            {open && (
              <div className="border-t border-slate-100 px-6 py-6">
                <ResumeDocument resume={item.resume} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
