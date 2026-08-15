import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy — career-path",
  description:
    "What career-path stores, what it doesn't, and how the browser extension handles your resume.",
};

export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <Link
        href="/"
        className="text-sm font-medium text-slate-500 transition hover:text-slate-900"
      >
        ← career-path
      </Link>

      <h1 className="mt-6 font-display text-3xl font-bold tracking-tight text-[#0E1220]">
        Privacy
      </h1>
      <p className="mt-2 text-sm text-slate-500">Last updated: 2026-08-14</p>

      <p className="mt-6 text-sm leading-relaxed text-slate-600">
        career-path is built so your resume stays yours. This page lists exactly
        what is stored and what is not, on the web app and in the browser
        extension.
      </p>

      <h2 className="mt-10 text-xl font-semibold text-[#0E1220]">
        What we never store
      </h2>
      <ul className="mt-3 list-disc space-y-1 pl-5 text-sm leading-relaxed text-slate-600">
        <li>Your resume file, or the text extracted from it.</li>
        <li>Job descriptions you paste, link, or screenshot.</li>
        <li>
          Tailored resumes — unless you sign in and click &ldquo;Save this
          version&rdquo;. The browser extension keeps a copy on your own
          device; see below.
        </li>
      </ul>
      <p className="mt-3 text-sm leading-relaxed text-slate-600">
        These pass through our servers to reach the language model that
        processes them, and are not written to any database.
      </p>

      <h2 className="mt-10 text-xl font-semibold text-[#0E1220]">
        What we do store
      </h2>
      <ul className="mt-3 list-disc space-y-1 pl-5 text-sm leading-relaxed text-slate-600">
        <li>
          Usage counters — quota and rate-limit counts keyed by your account,
          an anonymous ID your browser stores for the web app, your IP
          address, or, for a signed-out extension, a device ID our server
          issues and signs into a token kept on your device. We store a
          running count against each of these; we do not keep a directory of
          devices.
        </li>
        <li>
          Versions you explicitly save while signed in — deletable at any time
          from &ldquo;My resumes&rdquo;.
        </li>
        <li>
          Your email, plus an anonymous session ID and timestamp, if you join
          the waitlist.
        </li>
        <li>Aggregate model timing and token counts, with no user content attached.</li>
      </ul>

      <h2 className="mt-10 text-xl font-semibold text-[#0E1220]">
        The browser extension
      </h2>
      <p className="mt-3 text-sm leading-relaxed text-slate-600">
        The extension stores your resume in your browser&rsquo;s local
        extension storage (<code>chrome.storage.local</code>). It is never
        written to our servers for storage — it is sent with a request only
        when you ask for an analysis, and is discarded once that request
        completes.
      </p>
      <p className="mt-3 text-sm leading-relaxed text-slate-600">
        The extension also keeps the results it generates — the match analysis
        and the tailored resume — in that same local storage, each one keyed by
        the posting&rsquo;s address, so up to 20 job-posting URLs are kept on
        your device alongside them. Returning to a job posting shows what it
        produced there before instead of charging you for it again. They are
        never uploaded, and the panel has a button that clears them — it shows
        how many are cached, and removes all of them.
      </p>
      <p className="mt-3 text-sm leading-relaxed text-slate-600">
        The extension reads the job posting on the page you are viewing, and
        only when you open the panel there. It does not read any other page,
        and it does not collect your browsing history. A background service
        worker exists only to keep your device sign-in token fresh and to open
        the side panel — it does not scan pages or run analyses on its own.
      </p>

      <h2 className="mt-10 text-xl font-semibold text-[#0E1220]">
        Third parties
      </h2>
      <p className="mt-3 text-sm leading-relaxed text-slate-600">
        Language models are accessed through OpenRouter. Sign-in is handled by
        Clerk. Usage counters, saved versions, and aggregate stats live in
        Upstash Redis. The site is hosted on Vercel.
      </p>
    </main>
  );
}
