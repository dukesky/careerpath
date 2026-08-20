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

  async function confirm() {
    setBusy(true);
    try {
      await signOut();
      // Only the session ends when this is unchecked — the resume and any
      // cached results are left exactly as they were. Nothing here reads
      // back what was cleared; the caller (App.tsx) resets the panel's own
      // displayed state, and only when this was true.
      if (removeLocal) {
        await clearResume();
        await clearCachedRuns();
      }
      onConfirmed(removeLocal);
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
