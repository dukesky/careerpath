import { useEffect, useState } from "react";
import { fetchQuota } from "@/lib/quota";
import { clearBetaCode, getBetaCode, setBetaCode } from "@/lib/storage";

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
 *
 * The same unknown-vs-definite-negative distinction governs what this
 * component RENDERS, which is why it reads the stored code itself rather than
 * inferring it from `unlimited`. App passes `unlimited: false` whenever its
 * `quota` is null — which covers both a failed quota fetch and the window
 * inside every `refreshQuota` — so "false" here means "no code in force, or
 * we don't know". Treating that as "nothing is stored" is what left a stored
 * code with no way to remove it: Remove used to exist only on the unlimited
 * branch, so a code the server had since rotated would keep riding along on
 * every request with no UI to clear it.
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
  // What is actually in chrome.storage.local right now, read on mount and
  // re-derived after every apply/remove — the only reliable answer to "is a
  // code stored", per the doc comment above.
  const [storedCode, setStoredCode] = useState<string | null>(null);

  useEffect(() => {
    // getBetaCode swallows its own read failures and resolves null, so this
    // cannot reject.
    void getBetaCode().then(setStoredCode);
  }, []);

  /**
   * Removes the stored code, reporting a storage failure to the caller
   * instead of throwing it. chrome.storage.local.remove can reject (a full
   * or unavailable profile store), and both callers below are invoked with
   * `void` — so an unguarded rejection would vanish as an unhandled promise
   * with nothing on screen, while the code stayed on every request.
   */
  async function forgetStoredCode(): Promise<boolean> {
    try {
      await clearBetaCode();
      setStoredCode(null);
      return true;
    } catch (err) {
      console.warn(
        JSON.stringify({
          evt: "beta_code_clear_failed",
          message: err instanceof Error ? err.message : String(err),
        }),
      );
      // Re-read rather than assume: the write failed, so what is in storage
      // is whatever was there before.
      setStoredCode(await getBetaCode());
      return false;
    }
  }

  async function apply() {
    const trimmed = code.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      try {
        await setBetaCode(trimmed);
      } catch (err) {
        // Nothing was stored, so there is nothing to verify and nothing to
        // clean up — say so and stop, rather than letting the rejection
        // escape into a `void`-ed call with no user feedback.
        console.warn(
          JSON.stringify({
            evt: "beta_code_store_failed",
            message: err instanceof Error ? err.message : String(err),
          }),
        );
        setError("Couldn't save that code. Try again.");
        return;
      }
      setStoredCode(trimmed);
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
        // request while buying nothing. If the removal itself fails the
        // verdict is still reported, and so is the fact that the code is
        // still there — the user needs both.
        setError(
          (await forgetStoredCode())
            ? "That code didn't work."
            : "That code didn't work, and it couldn't be removed. Try again.",
        );
      }
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      if (await forgetStoredCode()) {
        onChanged();
      } else {
        setError("Couldn't remove that code. Try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  const removeButton = storedCode ? (
    <button className="textbtn" onClick={() => void remove()} disabled={busy}>
      Remove
    </button>
  ) : null;

  if (unlimited) {
    return (
      <div>
        <p className="muted tiny center">Beta · unlimited {removeButton}</p>
        {error && <p className="error">{error}</p>}
      </div>
    );
  }

  if (open) {
    return (
      <div>
        <input
          className="paste"
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
        {/* Only reachable one way: the code was applied and the verification
            request itself failed, so it is stored but unconfirmed. Offering
            Remove here is the difference between "keep it and see" and being
            stuck with a code nothing on screen can clear. */}
        {removeButton}
        {error && <p className="error">{error}</p>}
      </div>
    );
  }

  if (storedCode) {
    // A code is stored, but the quota does not (or cannot) say it is in
    // force. Deliberately not worded as if it were working — "stored" is all
    // that is actually known here.
    return (
      <div>
        <p className="muted tiny center">Beta code stored {removeButton}</p>
        {error && <p className="error">{error}</p>}
      </div>
    );
  }

  return (
    <button className="textbtn" onClick={() => setOpen(true)}>
      Have a beta code?
    </button>
  );
}
