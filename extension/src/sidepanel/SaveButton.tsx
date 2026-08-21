import { useState } from "react";
import type { ParsedResume } from "@shared/contract";
import { apiPost } from "@/lib/api";
import { signInPageUrl } from "@/lib/clerk";

type SaveStatus = "idle" | "saving" | "saved" | "error" | "session_expired";

/**
 * Saves the currently-displayed tailored resume to the web app, viewable
 * later at `/app/saved`. Beside DownloadPdf in Results.tsx, but deliberately
 * NOT sharing state with it: same house style as DownloadPdf (its own local
 * status, self-contained), because this control's failure modes (auth,
 * network) are unrelated to PDF generation and neither should be able to
 * clear the other's status.
 *
 * The request body's field names are matched exactly against
 * `src/app/api/saved/route.ts`'s POST handler — see that file, and the web
 * app's own equivalent save call in `src/app/app/page.tsx`
 * (`saveCurrentVersion`), which sends the same shape from the structured JD
 * it has and this extension does not: the extension only ever extracts raw
 * JD text (see `@/content/extract`'s `ExtractedJD`), never the parsed
 * `company_context_hints` the web app uses for `jdSummary`. The raw JD text
 * is the closest equivalent available here, and the server already caps
 * `jdSummary` at 500 characters, so no client-side truncation is needed.
 *
 * Rendered ONLY when signed in (Results.tsx's job, not this component's) —
 * a signed-out user must never see a Save control that would just 401.
 */
export function SaveButton({
  resume,
  company,
  roleTitle,
  jdSummary,
  jdUrl,
}: {
  resume: ParsedResume;
  company: string;
  roleTitle: string;
  jdSummary: string;
  /** Only sent when it is a real http(s) URL — the route rejects anything else anyway. */
  jdUrl?: string;
}) {
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function save() {
    setStatus("saving");
    setMessage(null);
    const result = await apiPost<{ saved: unknown }>("/api/saved", {
      company,
      roleTitle,
      resume,
      jdSummary,
      ...(jdUrl ? { jdUrl } : {}),
    });
    if (!result.ok) {
      // Same treatment as App.tsx's own session_expired card (see its doc
      // comment near `state.error?.kind === "session_expired"`) — duplicated
      // here rather than shared, because this control's status is its own
      // small state machine, independent of the run's.
      if (result.kind === "session_expired") {
        setStatus("session_expired");
      } else {
        setStatus("error");
        setMessage(result.message);
      }
      return;
    }
    setStatus("saved");
  }

  return (
    <>
      <button onClick={() => void save()} disabled={status === "saving"}>
        {status === "saving" ? "Saving…" : status === "saved" ? "Saved ✓" : "Save to career-path"}
      </button>
      {status === "error" && message && <p className="error">{message}</p>}
      {status === "session_expired" && (
        <section className="card">
          <p className="muted tiny">Sign in to pick up where you left off.</p>
          <a className="btn primary" href={signInPageUrl()} target="_blank" rel="noreferrer">
            Sign in again
          </a>
        </section>
      )}
    </>
  );
}
