import { useCallback, useEffect, useState } from "react";
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

  const read = useCallback(async () => {
    setLoading(true);
    setFailure(null);
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        setFailure("No active tab.");
        return;
      }
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: [contentScriptPath],
      });
      const result = (await chrome.tabs.sendMessage(tab.id, {
        type: "CP_EXTRACT_JD",
      })) as ExtractResult | undefined;

      if (!result || !result.ok) {
        setJd(null);
        setFailure("We couldn't read a job posting on this page.");
        return;
      }
      setJd(result.jd);
    } catch {
      setJd(null);
      setFailure("We couldn't read this page. Try reloading it.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void read();
  }, [read]);

  return { jd, failure, loading, reread: read, setJd };
}
