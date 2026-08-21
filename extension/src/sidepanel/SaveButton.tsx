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
 *
 * `onSavingChange` exists to close a lost-feedback race, not to report
 * progress for its own sake: `Results.tsx` keys this component on
 * `generatedAt` so a NEW completed run gets a clean idle Save status (see
 * that key's own comment). But a regenerate can start while a save from the
 * PREVIOUS result is still in flight — the two are otherwise uncoordinated.
 * If that happened, the new run's `generatedAt` would change the key,
 * React would unmount this instance, and the in-flight `apiPost` would
 * later resolve into `setStatus(...)` on a component that no longer exists
 * — a silent no-op. The user would see the Save button they were watching
 * simply vanish, replaced by a fresh one for the new result, with no
 * indication of whether their save succeeded. `App.tsx` uses this callback
 * to disable both regenerate triggers for the duration of a save, which
 * removes the race's precondition entirely (regenerate cannot start while
 * this component might still be unmounted out from under a pending
 * request) rather than trying to make the clobbered result recoverable
 * after the fact.
 */
export function SaveButton({
  resume,
  company,
  roleTitle,
  jdSummary,
  jdUrl,
  onSavingChange,
}: {
  resume: ParsedResume;
  company: string;
  roleTitle: string;
  jdSummary: string;
  /** Only sent when it is a real http(s) URL — the route rejects anything else anyway. */
  jdUrl?: string;
  /** See this component's doc comment — fired true right before the request, false right after it settles. */
  onSavingChange: (saving: boolean) => void;
}) {
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function save() {
    setStatus("saving");
    setMessage(null);
    onSavingChange(true);
    // apiPost never rejects (see api.ts's `send` — every failure mode is
    // folded into `ApiResult`'s `ok: false` branch), so a single call site
    // right after the await, before branching on `result.ok`, is enough to
    // cover both outcomes.
    const result = await apiPost<{ saved: unknown }>("/api/saved", {
      company,
      roleTitle,
      resume,
      jdSummary,
      ...(jdUrl ? { jdUrl } : {}),
    });
    onSavingChange(false);
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
      {/* Disabled once SAVED as well as while saving. A "Saved ✓" button
          that is still clickable creates a second saved version server-side
          for a result the user has already saved — /api/saved appends, it
          does not upsert — and the button's own label gives no hint that
          clicking again would do anything at all. A genuinely new result
          gets a genuinely new button: Results.tsx keys this component on
          `generatedAt`, so a fresh run remounts it at idle. */}
      <button
        onClick={() => void save()}
        disabled={status === "saving" || status === "saved"}
      >
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
