import { useState } from "react";
import { fetchQuota } from "@/lib/quota";
import { clearBetaCode, setBetaCode } from "@/lib/storage";

/**
 * The panel's beta-code entry, mirroring the web app's header control.
 *
 * A code has to be entered here separately from the website: the extension's
 * chrome.storage.local is isolated from the page's storage, so there is no
 * way to read one the user already entered there.
 *
 * Validation has no dedicated endpoint and does not need one — applying the
 * code and re-reading GET /api/quota answers the question directly. If the
 * quota comes back unlimited the server accepted it; if it does not, the code
 * is wrong and is removed again immediately, because a rejected code left in
 * storage would ride along on every later request while buying nothing.
 *
 * `fetchQuota()` returns `null` for ANY request failure — network blip, a
 * 5xx, an unreachable quota store — not only "not unlimited" (see quota.ts).
 * That is a DIFFERENT outcome from a definite rejection: we simply failed to
 * ask, so the code must NOT be cleared on `null`. Clearing it there would
 * destroy a perfectly good code over a transient hiccup and tell the user it
 * was wrong when it was never actually checked.
 */
export function BetaCodeBox({
  unlimited,
  onChanged,
}: {
  /** From App's quota state — whether a code is currently in force. */
  unlimited: boolean;
  /** Fired after storage changed, so App can re-read the allowance. */
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function apply() {
    const trimmed = code.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      await setBetaCode(trimmed);
      // Deliberately a second read rather than reusing App's: this component
      // needs the answer to decide accept-or-reject before App is told
      // anything, and a rare user-initiated action is the wrong place to
      // trade clarity for one saved request.
      const quota = await fetchQuota();
      if (quota === null) {
        // Could not ASK, which is not the same as being told no. fetchQuota
        // returns null for any request failure — a network blip, a 5xx, an
        // unreachable quota store. Clearing the code here would destroy a
        // perfectly good one and blame the user for it, so the code stays
        // and the message says what actually happened.
        setError("Couldn't check that code. Try again.");
      } else if (quota.unlimited) {
        setOpen(false);
        setCode("");
        onChanged();
      } else {
        // A definite answer: the server does not recognise this code. It
        // must not survive in storage — it would ride along on every later
        // request while buying nothing.
        await clearBetaCode();
        setError("That code didn't work.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await clearBetaCode();
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  if (unlimited) {
    return (
      <p className="muted tiny center">
        Beta · unlimited{" "}
        <button className="textbtn" onClick={() => void remove()} disabled={busy}>
          Remove
        </button>
      </p>
    );
  }

  if (!open) {
    return (
      <button className="textbtn" onClick={() => setOpen(true)}>
        Have a beta code?
      </button>
    );
  }

  return (
    <div>
      <input
        type="text"
        placeholder="Beta code"
        value={code}
        onChange={(e) => {
          setCode(e.target.value);
          setError(null);
        }}
      />
      <button onClick={() => void apply()} disabled={busy || code.trim().length === 0}>
        {busy ? "Checking…" : "Apply"}
      </button>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
