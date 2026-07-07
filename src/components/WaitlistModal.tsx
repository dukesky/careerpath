"use client";

import { useState } from "react";
import { apiHeaders } from "@/lib/anon";

export function WaitlistModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "done" | "error">(
    "idle",
  );
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  async function submit() {
    setStatus("submitting");
    setError(null);
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: apiHeaders(),
        body: JSON.stringify({ email: email.trim() }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "Something went wrong. Please try again.");
        setStatus("error");
        return;
      }
      setStatus("done");
    } catch {
      setError("Network error. Please try again.");
      setStatus("error");
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div className="grid h-11 w-11 place-items-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-5 w-5"
              aria-hidden="true"
            >
              <path d="M13 3 15.5 9.5 22 12l-6.5 2.5L13 21l-2.5-6.5L4 12l6.5-2.5L13 3Z" />
            </svg>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
            aria-label="Close"
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

        {status === "done" ? (
          <div className="mt-4">
            <h2 className="text-lg font-semibold text-slate-900">
              You&apos;re on the list! 🎉
            </h2>
            <p className="mt-1.5 text-sm text-slate-600">
              Thanks — we&apos;ll email you when paid credits launch, along with
              your bonus credits for being early.
            </p>
            <button
              type="button"
              onClick={onClose}
              className="mt-5 w-full rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800"
            >
              Done
            </button>
          </div>
        ) : (
          <div className="mt-4">
            <h2 className="text-lg font-semibold text-slate-900">
              You&apos;ve used your free tailors
            </h2>
            <p className="mt-1.5 text-sm text-slate-600">
              Paid credits are coming soon — leave your email to get early access
              plus bonus credits.
            </p>

            <div className="mt-4">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && email.trim() !== "") {
                    e.preventDefault();
                    void submit();
                  }
                }}
                placeholder="you@example.com"
                className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-800 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
              />
              {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
              <button
                type="button"
                onClick={() => void submit()}
                disabled={email.trim() === "" || status === "submitting"}
                className="mt-3 w-full rounded-xl bg-gradient-to-r from-indigo-600 to-violet-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:from-indigo-500 hover:to-violet-500 disabled:cursor-not-allowed disabled:from-slate-300 disabled:to-slate-300"
              >
                {status === "submitting" ? "Joining…" : "Get early access"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
