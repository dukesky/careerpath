import Link from "next/link";
import { Logo } from "@/components/Logo";
import {
  SignedIn,
  SignedOut,
  SignInButton,
  SignUpButton,
  UserButton,
} from "@/components/clerk-auth";

const steps = [
  {
    n: 1,
    title: "Upload your resume",
    body: "Drop in your current resume as a PDF or DOCX. It never leaves your session.",
    icon: (
      <>
        <path d="M12 16V5m0 0L8 9m4-4l4 4" />
        <path d="M5 15v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2" />
      </>
    ),
  },
  {
    n: 2,
    title: "Paste the job description",
    body: "Drop in the JD text or a link. We read what the role actually asks for.",
    icon: (
      <>
        <rect x="5" y="4" width="14" height="16" rx="2" />
        <path d="M8.5 9h7M8.5 12.5h7M8.5 16h4" />
      </>
    ),
  },
  {
    n: 3,
    title: "Get a tailored resume + gap analysis",
    body: "A resume rewritten for the role, plus an honest read on where you fall short.",
    icon: (
      <>
        <rect x="4" y="5" width="16" height="15" rx="2" />
        <path d="M8.5 12.5l2.2 2.2 4.3-4.7" />
      </>
    ),
  },
];

export default function Home() {
  return (
    <div className="flex min-h-full flex-col">
      {/* Hero band with soft violet glow */}
      <div className="relative overflow-hidden bg-gradient-to-b from-[#FBFAFF] to-[#F5F3FF]">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-32 left-1/2 h-[420px] w-[640px] animate-glow rounded-full bg-[radial-gradient(closest-side,rgba(124,58,237,0.28),rgba(124,58,237,0))] blur-2xl"
        />

        <header className="relative mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-6">
          <Logo />
          <div className="flex items-center gap-5 sm:gap-7">
            <a
              href="#how-it-works"
              className="hidden text-[15px] font-medium text-slate-600 transition hover:text-slate-900 sm:inline"
            >
              How it works
            </a>
            <SignedOut>
              <SignInButton mode="modal">
                <button
                  type="button"
                  className="text-[15px] font-medium text-slate-600 transition hover:text-slate-900"
                >
                  Sign in
                </button>
              </SignInButton>
              <SignUpButton mode="modal">
                <button
                  type="button"
                  className="hidden rounded-[10px] border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 sm:inline-flex"
                >
                  Sign up
                </button>
              </SignUpButton>
            </SignedOut>
            <SignedIn>
              <Link
                href="/app/saved"
                className="hidden text-[15px] font-medium text-slate-600 transition hover:text-slate-900 sm:inline"
              >
                My resumes
              </Link>
              <UserButton appearance={{ elements: { avatarBox: "h-8 w-8" } }} />
            </SignedIn>
            <Link
              href="/app"
              className="inline-flex items-center gap-2 rounded-[10px] bg-[#0E1220] px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-[#1c2236]"
            >
              Open the app <span aria-hidden="true">→</span>
            </Link>
          </div>
        </header>

        <section className="relative mx-auto flex w-full max-w-6xl flex-col items-center px-6 pb-16 pt-8 text-center sm:pb-24">
          <span className="inline-flex items-center gap-2.5 rounded-full border border-[#E7E3F5] bg-white px-4 py-2 text-sm font-medium text-[#3D2B66] shadow-[0_2px_8px_-3px_rgba(80,50,160,0.18)]">
            <span className="h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_0_3px_rgba(34,192,99,0.18)]" />
            Private by design — nothing is stored
          </span>

          <h1 className="font-display mt-7 max-w-3xl text-5xl font-extrabold leading-[1.02] tracking-tight text-[#0E1220] sm:text-[72px]">
            Tailor your resume to any{" "}
            <span className="bg-gradient-to-r from-[#7C3AED] to-[#C026D3] bg-clip-text text-transparent">
              job description
            </span>
          </h1>

          <p className="mt-6 max-w-xl text-lg leading-relaxed text-[#565B6D] sm:text-xl">
            Upload once, paste a role, and get a resume rewritten for the job —
            plus an honest read on where you fall short.
          </p>

          <div className="mt-9 flex flex-col items-center gap-4 sm:flex-row sm:gap-5">
            <Link
              href="/app"
              className="inline-flex items-center gap-2 rounded-xl bg-[#0E1220] px-7 py-4 text-[17px] font-semibold text-white shadow-[0_14px_30px_-12px_rgba(14,18,32,0.55)] transition hover:bg-[#1c2236]"
            >
              Tailor my resume <span aria-hidden="true">→</span>
            </Link>
            <span className="text-[15px] text-[#7C8092]">
              Free to try · No account needed
            </span>
          </div>
        </section>
      </div>

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-6">
        {/* 3-step visual */}
        <section id="how-it-works" className="py-16 sm:py-24">
          <div className="grid gap-6 md:grid-cols-3">
            {steps.map((step) => (
              <div
                key={step.n}
                className="rounded-2xl border border-[#ECECF2] bg-gradient-to-b from-white to-[#FCFBFF] p-7 shadow-sm"
              >
                <div className="flex items-center gap-3">
                  <span className="grid h-[42px] w-[42px] place-items-center rounded-xl bg-[#F1ECFE] text-[#7C3AED]">
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
                  <span className="font-display text-[13px] font-bold uppercase tracking-[0.08em] text-[#A99AD8]">
                    Step {step.n}
                  </span>
                </div>
                <h3 className="font-display mt-5 text-[22px] font-bold text-[#0E1220]">
                  {step.title}
                </h3>
                <p className="mt-2.5 text-[15.5px] leading-relaxed text-[#606574]">
                  {step.body}
                </p>
              </div>
            ))}
          </div>
        </section>
      </main>

      <footer className="mx-auto w-full max-w-6xl px-6 py-8 text-sm text-slate-400">
        <div className="flex flex-col items-center justify-between gap-2 border-t border-slate-200 pt-6 sm:flex-row">
          <span>© 2026 career-path</span>
          <span>
            Your resume and JD are processed in-session — never saved unless you
            sign in and save a version.
          </span>
        </div>
      </footer>
    </div>
  );
}
