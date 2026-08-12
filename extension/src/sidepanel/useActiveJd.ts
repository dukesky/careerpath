import { useCallback, useEffect, useRef, useState } from "react";
import type { ExtractResult, ExtractedJD } from "@/content/extract";
import { classifyInjectionError } from "@/lib/permissions";
// CRXJS's `?script` import gives back the actual built filename for a script
// that is NOT declared in the manifest's `content_scripts` — which is exactly
// what activeTab + chrome.scripting.executeScript needs. The manifest stays
// free of a content_scripts entry (no <all_urls> permission prompt at
// install); CRXJS still bundles this file, rewrites its path per build, and
// wires up HMR for it in dev. Do not replace this with a hardcoded string —
// see useActiveJd.ts's history for why that broke silently.
//
// The `&iife` is load-bearing, not decorative: `chrome.scripting.executeScript`
// with `files` only runs classic (non-module) scripts. Per the plugin's own
// type detection, plain `?script` resolves to the built IIFE path in a
// production build but to an unhashed ESM path under `vite dev` — silently
// breaking `executeScript` in dev. `iife` in the query string forces IIFE
// output in BOTH serve and build, so this import resolves the same shape
// either way.
import contentScriptPath from "@/content/index.ts?script&iife";

/**
 * Why a read failed. The panel needs the kind, not just a sentence: only
 * "permission" is worth offering a grant for.
 */
export interface ReadFailure {
  kind: "permission" | "restricted" | "unknown" | "no-posting" | "no-tab";
  message: string;
}

/**
 * Reads the JD from the active tab by injecting the content script on demand.
 *
 * Page access does NOT come from `activeTab` alone: the side panel is
 * window-global and follows tab switches, so there is no click on a specific
 * tab for `activeTab` to key off. Instead, the manifest's `host_permissions`
 * grant five job sites at install with no click needed, and
 * `optional_host_permissions` declares a broad origin set the panel can
 * request from a user gesture (see `lib/permissions.ts`) for everywhere
 * else. `activeTab` remains declared as a residual — it covers the tab the
 * user explicitly invoked the extension icon on, ahead of either of those.
 */
export function useActiveJd() {
  const [jd, setJd] = useState<ExtractedJD | null>(null);
  const [failure, setFailure] = useState<ReadFailure | null>(null);
  const [loading, setLoading] = useState(true);
  // Tab events can fire in quick succession (A -> B -> C), and each call to
  // `read()` starts its own independent async round-trip (query, then
  // executeScript, then sendMessage) with no guaranteed order of completion.
  // Without a generation guard, A's slower round-trip could resolve AFTER
  // C's and overwrite `jd`/`failure` with stale data for a posting the user
  // has already left — which then feeds App.tsx's `activeJdUrlRef`, the very
  // thing that guard relies on being correct. Every `read()` claims the next
  // sequence number; only the invocation still holding the current number at
  // each commit point is allowed to write state.
  const readSeq = useRef(0);

  const read = useCallback(async () => {
    const seq = ++readSeq.current;
    setLoading(true);
    setFailure(null);
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (seq !== readSeq.current) return; // superseded by a newer read
      if (!tab?.id) {
        setJd(null);
        setFailure({ kind: "no-tab", message: "No active tab." });
        return;
      }
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: [contentScriptPath],
      });
      if (seq !== readSeq.current) return; // superseded by a newer read

      const result = (await chrome.tabs.sendMessage(tab.id, {
        type: "CP_EXTRACT_JD",
      })) as ExtractResult | undefined;
      if (seq !== readSeq.current) return; // superseded by a newer read

      if (!result || !result.ok) {
        setJd(null);
        setFailure({
          kind: "no-posting",
          message: "We couldn't read a job posting on this page.",
        });
        return;
      }
      setJd(result.jd);
    } catch (err) {
      // This catch covers BOTH executeScript and sendMessage, and the two fail
      // for completely different reasons that need completely different fixes:
      // Chrome's host-permission wording ("Cannot access contents of the
      // page...") means the site isn't covered by host_permissions or the
      // broad optional grant, and IS worth offering the grant for. "Could not
      // establish connection..." means the script injected fine but no
      // listener answered (e.g. this read raced a navigation) — access was
      // never the problem, so it must not be diagnosed as one. Swallowing
      // this made the panel's copy the only signal, which is not enough to
      // debug from.
      console.warn(
        JSON.stringify({ evt: "cp_extract_failed", error: String(err) }),
      );
      if (seq !== readSeq.current) return; // superseded by a newer read
      const kind = classifyInjectionError(err);
      setJd(null);
      setFailure(
        kind === "restricted"
          ? { kind, message: "This page can't be read by extensions." }
          : kind === "permission"
            ? {
                kind,
                message: "career-path doesn't have permission to read this site.",
              }
            : { kind, message: "We couldn't read this page. Try reloading it." },
      );
    } finally {
      // A superseded read must not clear a newer read's loading state —
      // either the newer read is still in flight (loading should stay true)
      // or it already finished and set loading false itself.
      if (seq === readSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void read();
  }, [read]);

  // The panel is window-global and outlives tab switches, so a stale read
  // would tailor against the posting the user just left. Also covers full
  // (non-SPA) navigations in the current tab; SPA route changes are B2.
  useEffect(() => {
    const onActivated = () => void read();
    const onUpdated = (
      _tabId: number,
      info: chrome.tabs.TabChangeInfo,
      tab: chrome.tabs.Tab,
    ) => {
      if (info.status === "complete" && tab.active) void read();
    };
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    return () => {
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
  }, [read]);

  return { jd, failure, loading, reread: read, setJd };
}
