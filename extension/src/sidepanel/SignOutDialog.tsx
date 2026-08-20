import { useState } from "react";
import { signOut } from "@/lib/clerk";
import { clearResume } from "@/lib/storage";
import { clearCachedRuns } from "@/lib/cache";

/**
 * The confirmation shown when the user clicks "Sign out" in AccountBar.
 * Owns the checkbox and the async work of signing out — AccountBar only
 * decides whether to render this and what to do once it resolves.
 *
 * The checkbox is checked BY DEFAULT. Only the user knows whether this is a
 * shared machine; the safe outcome has to be the one that happens if they
 * click through without reading, not the one that happens if they read
 * carefully and opt in.
 */
export function SignOutDialog({
  onCancel,
  onConfirmed,
}: {
  onCancel: () => void;
  /** Fired after signOut() (and any requested local clear) has resolved. */
  onConfirmed: (removedLocalData: boolean) => void;
}) {
  const [removeLocal, setRemoveLocal] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      // Local data first, signOut() LAST. This ordering is deliberate: it is
      // what makes it impossible for the session to end while this dialog
      // (and the AccountBar behind it) still shows the user signed in — the
      // same "header still shows their email for a session that's gone" lie
      // the session_expired fork exists to prevent elsewhere in this panel.
      // If clearing throws, signOut() below is never reached and nothing
      // has changed: the user is still genuinely signed in, and the UI
      // (having never called onConfirmed) still accurately says so. Putting
      // signOut() first would invert that: a clearResume()/clearCachedRuns()
      // failure AFTER a successful signOut() would end the session while
      // onConfirmed — and so handleSignedOut — never runs, leaving the bar
      // stuck showing a signed-in user whose session already ended.
      if (removeLocal) {
        await clearResume();
        await clearCachedRuns();
      }
      await signOut();
      onConfirmed(removeLocal);
    } catch (err) {
      // Surfaced and the dialog stays open (no onCancel/onConfirmed call) so
      // the user can retry rather than being silently left in an ambiguous
      // state — same posture as session.ts's own catch for a Clerk failure.
      console.warn(
        JSON.stringify({
          evt: "sign_out_failed",
          message: err instanceof Error ? err.message : String(err),
        }),
      );
      setError("Couldn't sign out. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dialog-overlay" onClick={() => !busy && onCancel()}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Sign out"
        onClick={(e) => e.stopPropagation()}
      >
        <p>Sign out of career-path?</p>
        <label className="dialog-checkbox">
          <input
            type="checkbox"
            checked={removeLocal}
            onChange={(e) => setRemoveLocal(e.target.checked)}
            disabled={busy}
          />
          Also remove my resume and saved results from this browser.
        </label>
        {error && <p className="error">{error}</p>}
        <div className="dialog-actions">
          <button onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button onClick={() => void confirm()} disabled={busy}>
            {busy ? "Signing out…" : "Sign out"}
          </button>
        </div>
      </div>
    </div>
  );
}
