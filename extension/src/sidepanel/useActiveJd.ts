import { useCallback, useEffect, useRef, useState } from "react";
import type { ExtractResult, ExtractedJD } from "@/content/extract";
// CRXJS's `?script` import gives back the actual built filename for a script
// that is NOT declared in the manifest's `content_scripts` — which is exactly
// what activeTab + chrome.scripting.executeScript needs. The manifest stays
// free of a content_scripts entry (no <all_urls> permission prompt at
// install); CRXJS still bundles this file, rewrites its path per build, and
// wires up HMR for it in dev. Do not replace this with a hardcoded string —
// see useActiveJd.ts's history for why that broke silently.
import contentScriptPath from "@/content/index.ts?script";

/**
 * Reads the JD from the active tab by injecting the content script on demand.
 * `activeTab` means the user clicking our icon IS the permission grant for
 * that tab — which is why the manifest asks for no host permissions on job
 * sites and the install prompt stays narrow.
 */
export function useActiveJd() {
  const [jd, setJd] = useState<ExtractedJD | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
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
        setFailure("No active tab.");
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
        setFailure("We couldn't read a job posting on this page.");
        return;
      }
      setJd(result.jd);
    } catch {
      if (seq !== readSeq.current) return; // superseded by a newer read
      setJd(null);
      setFailure("We couldn't read this page. Try reloading it.");
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
