import { useState } from "react";
import { signInPageUrl } from "@/lib/clerk";
import { SignOutDialog } from "./SignOutDialog";

/**
 * Identity and allowance, rendered above the resume card. This component
 * fetches nothing itself — `signedIn`/`email` are one-shot Clerk reads owned
 * by App.tsx (see its mount effect and the comment there on why re-checking
 * is App's job, not this component's), and `remaining`/`unlimited` are
 * App.tsx's own derived values: a completed run's RunState.remaining when
 * present, falling back to the GET /api/quota reading it keeps refreshed on
 * every identity change (see App.tsx's `refreshQuota`). Both nulls are
 * meaningful and distinct — see QuotaInfo's doc comment in lib/quota.ts —
 * and this component renders no number at all for either.
 */
export function AccountBar({
  signedIn,
  email,
  remaining,
  unlimited,
  busy,
  saving,
  onLocalDataCleared,
  onSignedOut,
}: {
  signedIn: boolean;
  /** Null while signed out, or briefly while signed in before Clerk reports it. */
  email: string | null;
  /**
   * App.tsx's derived `displayRemaining`: a completed run's RunState.remaining
   * when present, otherwise the quota fetched at open/identity-change. Null
   * means UNKNOWN, never zero — see lib/quota.ts's QuotaInfo doc comment.
   */
  remaining: number | null;
  /**
   * From GET /api/quota, not from the run — a beta code lifts the cap
   * entirely, so there is no number to show and showing one would be a lie.
   */
  unlimited: boolean;
  /**
   * Whether ANY run is in flight — App.tsx passes `busy || anyRunning`, not
   * the displayed posting's `busy` alone, and the difference is load-bearing.
   * Runs live in the background service worker now, keyed per posting, up to
   * five at once; the panel is only a view of one of them. Signing out with
   * the box checked clears the resume, the cache and the live runs, so it is
   * a SECOND route to exactly what the "Clear N cached results" control's own
   * `disabled` guards against — except that here the run that repaints and
   * re-persists the previous session's result afterwards need not be the one
   * on screen, or on any screen. Narrowing this back to the displayed
   * posting reopens that.
   */
  busy: boolean;
  /**
   * App.tsx's `saving` — whether a Save (SaveButton, inside Results) has a
   * POST to /api/saved in flight. A SEPARATE prop from `busy` rather than
   * folded into it, because the two state different facts — a save is not a
   * run, and no run being in flight says nothing about a POST on the wire;
   * only the Sign-out button's own `disabled` combines them.
   *
   * Sign-out is the FOURTH door into the save-in-flight lost-feedback race
   * that SaveButton's `onSavingChange` exists to close, and the worst of
   * them. Signing out mid-save unmounts SaveButton through BOTH of
   * Results.tsx's gates — `tailored &&` (reset by onLocalDataCleared) and
   * `signedIn ||` (reset by onSignedOut) — while the POST stays on the wire
   * carrying a still-valid token. It can therefore still land in the account
   * the user just asked to leave, with nothing on screen ever saying so.
   */
  saving: boolean;
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
            {/* The allowance leads. What the user HAS is the fact that
                belongs first; what signing in would add is secondary. The
                old "Not signed in" label led with what they lacked, which
                is why the panel read as a gate for a feature that has never
                required an account. */}
            {unlimited ? (
              <div className="label">Beta · unlimited</div>
            ) : remaining !== null ? (
              // No "today" here — the signed-out device tier is 3 runs per
              // 30 days, not a daily allowance, so borrowing the signed-in
              // branch's "left today" wording would misstate the period.
              <div className="label">
                {remaining} run{remaining === 1 ? "" : "s"} left
              </div>
            ) : null}
            {/* Not under `Beta · unlimited`. A signed-out beta caller has no
                cap at all, so pitching them 5 runs a day is pitching a
                downgrade as an upgrade. Every other signed-out state — a
                known count, or none — is genuinely improved by signing in,
                so the line stays there. */}
            {!unlimited && <p className="muted tiny">Sign in for 5 runs a day.</p>}
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
          {unlimited ? (
            <p className="muted tiny">Beta · unlimited</p>
          ) : remaining !== null ? (
            <p className="muted tiny">
              {remaining} run{remaining === 1 ? "" : "s"} left today
            </p>
          ) : null}
        </div>
        <button onClick={() => setDialogOpen(true)} disabled={busy || saving}>
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
