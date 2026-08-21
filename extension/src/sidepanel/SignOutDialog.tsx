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
  onLocalDataCleared,
  onSignedOut,
}: {
  onCancel: () => void;
  /**
   * Fired the INSTANT clearResume()/clearCachedRuns() have both succeeded
   * (only when the box is checked), BEFORE signOut() is even attempted.
   * This has to be reported independently of onSignedOut below: local
   * clearing and ending the Clerk session are two separate operations that
   * can fail independently, and chrome.storage.local really is empty the
   * moment this fires regardless of what signOut() does next. Bundling this
   * behind a later "both succeeded" signal (as an earlier version of this
   * dialog did) meant a signOut()-specific failure — clearing succeeds,
   * signOut() then throws — left the panel still showing the previous
   * session's resume/cache/run state as if nothing happened, while storage
   * underneath had genuinely already lost it. That's a data-loss-hidden-by-
   * stale-UI bug, not a cosmetic one: the panel would show data that no
   * longer exists.
   */
  onLocalDataCleared: () => void;
  /** Fired once signOut() itself has resolved successfully. */
  onSignedOut: () => void;
}) {
  const [removeLocal, setRemoveLocal] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      // Local data first, signOut() LAST, and each reported to the caller
      // the moment it actually happens rather than bundled behind the other.
      // If clearing itself throws, signOut() below is never reached and
      // nothing has changed: the user is still genuinely signed in, and the
      // UI (having received neither callback) still accurately says so.
      // Once clearing succeeds, onLocalDataCleared() fires right away —
      // independently of whatever signOut() does next — because storage is
      // truly empty at that point regardless of the session's fate. If
      // signOut() then throws, the catch below surfaces the error and
      // leaves the dialog open, but the panel has already correctly
      // forgotten the cleared resume/cache/run state; it does not sit there
      // showing data that storage no longer has. See onLocalDataCleared's
      // own doc comment for the failure mode this prevents.
      if (removeLocal) {
        await clearResume();
        await clearCachedRuns();
        onLocalDataCleared();
      }
      await signOut();
      onSignedOut();
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
