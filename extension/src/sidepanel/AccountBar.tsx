import { useState } from "react";
import { signInPageUrl } from "@/lib/clerk";
import { SignOutDialog } from "./SignOutDialog";

/**
 * Identity and allowance, rendered above the resume card. Two states only —
 * this component does not fetch anything itself beyond "am I signed in and
 * as whom", both one-shot Clerk reads owned by App.tsx (see its mount effect
 * and the comment there on why re-checking is App's job, not this
 * component's). `remaining` is NOT re-fetched here: it already comes out of
 * generate()'s own RunState in App.tsx, and fetching it a second time would
 * both be redundant and risk showing a different number than the one the
 * run itself reported.
 */
export function AccountBar({
  signedIn,
  email,
  remaining,
  busy,
  onLocalDataCleared,
  onSignedOut,
}: {
  signedIn: boolean;
  /** Null while signed out, or briefly while signed in before Clerk reports it. */
  email: string | null;
  /** RunState.remaining, passed straight through — see run.ts. */
  remaining: number | null;
  /**
   * App.tsx's `busy` — whether generate() currently owns the display. Same
   * reasoning, same discipline as the "Clear N cached results" control a few
   * lines down the panel in App.tsx: signing out (with the box checked) also
   * clears the resume and the cache, so it is a SECOND route to exactly what
   * that control's own `disabled={busy}` guards against — a mid-run clear
   * that gets silently repainted and re-persisted the moment the run
   * resolves, because generate()'s own guard only keys on which POSTING is
   * active, not on whether the user is still signed in.
   */
  busy: boolean;
  /**
   * Fired the instant SignOutDialog has actually cleared local storage
   * (box checked only), independently of whether the subsequent signOut()
   * succeeds — see SignOutDialog's own doc comment on why these two signals
   * are separate. Threaded straight through with no wrapping needed.
   */
  onLocalDataCleared: () => void;
  /** Fired once sign-out has actually completed (signOut() resolved). */
  onSignedOut: () => void;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);

  if (!signedIn) {
    return (
      <section className="card">
        <div className="row">
          <div>
            <div className="label">Not signed in</div>
            <p className="muted tiny">
              Sign in to raise your limit from 3 runs every 30 days to 5 runs a day.
            </p>
            {remaining !== null && (
              // No "today" here — the signed-out device tier is 3 runs per
              // 30 days, not a daily allowance, so borrowing the signed-in
              // branch's "left today" wording would misstate the period.
              <p className="muted tiny">
                {remaining} run{remaining === 1 ? "" : "s"} left
              </p>
            )}
          </div>
          {/* A plain anchor, not chrome.tabs.create: opening a tab this way
              needs no `tabs` permission — same reasoning as the saved-resumes
              link further down the panel. The sign-in page is Clerk-gated and
              lives in its own tab (Clerk's chrome-extension sync host does not
              work inside a side panel), not a popup mounted here. */}
          <a className="btn" href={signInPageUrl()} target="_blank" rel="noreferrer">
            Sign in
          </a>
        </div>
      </section>
    );
  }

  return (
    <section className="card">
      <div className="row">
        <div>
          <div className="label">Signed in</div>
          <p className="muted tiny">{email ?? "Signed in"}</p>
          {remaining !== null && (
            <p className="muted tiny">
              {remaining} run{remaining === 1 ? "" : "s"} left today
            </p>
          )}
        </div>
        <button onClick={() => setDialogOpen(true)} disabled={busy}>
          Sign out
        </button>
      </div>
      {dialogOpen && (
        <SignOutDialog
          onCancel={() => setDialogOpen(false)}
          onLocalDataCleared={onLocalDataCleared}
          onSignedOut={() => {
            setDialogOpen(false);
            onSignedOut();
          }}
        />
      )}
    </section>
  );
}
