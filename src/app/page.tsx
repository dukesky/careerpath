import Link from "next/link";
import { Logo } from "@/components/Logo";

const steps = [
  {
    n: 1,
    title: "Upload your resume",
    body: "Drop in your current resume as a PDF or DOCX. It never leaves your session.",
    icon: (
      <>
        <path d="M12 15V3" />
        <path d="m7 8 5-5 5 5" />
        <path d="M5 21h14a2 2 0 0 0 2-2v-4" />
      </>
    ),
  },
  {
    n: 2,
    title: "Paste the job description",
    body: "Drop in the JD text (or a link). We read what the role actually asks for.",
    icon: (
      <>
        <rect x="4" y="3" width="16" height="18" rx="2" />
        <path d="M8 8h8" />
        <path d="M8 12h8" />
        <path d="M8 16h5" />
      </>
    ),
  },
  {
    n: 3,
    title: "Get a tailored resume + gap analysis",
    body: "A resume rewritten for the role, plus an honest read on where you fall short.",
    icon: (
      <>
        <path d="m9 11 3 3L22 4" />
        <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
      </>
    ),
  },
];

export default function Home() {
  return (
    <div className="flex min-h-full flex-col">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-5">
        <Logo />
        <Link
          href="/app"
          className="rounded-lg px-4 py-2 text-sm font-medium text-slate-600 transition hover:text-slate-900"
        >
          Open the app →
        </Link>
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-6">
        {/* Hero */}
        <section className="flex flex-col items-center py-16 text-center sm:py-24">
          <span className="mb-6 inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600 shadow-sm">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            Private by design — nothing is stored
          </span>

          <h1 className="max-w-3xl text-4xl font-semibold tracking-tight text-slate-900 sm:text-6xl">
            Tailor your resume to any{" "}
            <span className="bg-gradient-to-r from-indigo-600 to-violet-600 bg-clip-text text-transparent">
              job description
            </span>
          </h1>

          <p className="mt-6 max-w-2xl text-lg text-slate-600">
            Tailor your resume to any job description — nothing stored, nothing
            saved.
          </p>

          <div className="mt-10 flex flex-col items-center gap-3 sm:flex-row">
            <Link
              href="/app"
              className="rounded-xl bg-slate-900 px-6 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800"
            >
              Tailor my resume
            </Link>
            <span className="text-sm text-slate-500">
              Free to try · No account needed
            </span>
          </div>
        </section>

        {/* 3-step visual */}
        <section className="pb-24">
          <div className="grid gap-4 md:grid-cols-3 md:gap-0">
            {steps.map((step, i) => (
              <div key={step.n} className="relative flex md:flex-col">
                <div className="flex-1 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                  <div className="flex items-center gap-3">
                    <span className="grid h-11 w-11 place-items-center rounded-xl bg-indigo-50 text-indigo-600">
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
                        {step.icon}
                      </svg>
                    </span>
                    <span className="text-sm font-semibold text-slate-400">
                      Step {step.n}
                    </span>
                  </div>
                  <h3 className="mt-4 text-lg font-semibold text-slate-900">
                    {step.title}
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-slate-600">
                    {step.body}
                  </p>
                </div>

                {/* Connector arrow between cards (desktop) */}
                {i < steps.length - 1 && (
                  <div className="hidden md:flex md:w-8 md:items-center md:justify-center">
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
                      <path d="M5 12h14" />
                      <path d="m13 6 6 6-6 6" />
                    </svg>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      </main>

      <footer className="mx-auto w-full max-w-6xl px-6 py-8 text-sm text-slate-400">
        <div className="flex flex-col items-center justify-between gap-2 border-t border-slate-200 pt-6 sm:flex-row">
          <span>© 2026 career-path</span>
          <span>
            Your resume and JD are processed in-session and never saved.
          </span>
        </div>
      </footer>
    </div>
  );
}
