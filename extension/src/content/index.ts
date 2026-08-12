import { extractFromDocument, type ExtractResult } from "./extract";

/**
 * Injected on demand by the side panel via chrome.scripting. `executeScript`
 * re-executes this whole module every time useActiveJd reads the page — on
 * mount, on every tab activation, on every qualifying navigation — so without
 * a guard, the k-th read of a page leaves k listeners registered, each doing
 * a full `doc.cloneNode(true)` + Readability parse on every future message.
 * Twenty tab-switches back to one tab would mean twenty full-DOM clones per
 * message, growing without bound for the page's lifetime. Stash a flag on
 * globalThis (survives across re-executions of this script, since it targets
 * the same page realm) so registration happens exactly once per page.
 */
const globalWithFlag = globalThis as typeof globalThis & {
  __cpExtractListenerRegistered?: boolean;
};

if (!globalWithFlag.__cpExtractListenerRegistered) {
  globalWithFlag.__cpExtractListenerRegistered = true;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "CP_EXTRACT_JD") return;
    // Responding synchronously, so do NOT return true — that would tell Chrome
    // to hold the message channel open for an async reply that never comes.
    const result: ExtractResult = extractFromDocument(document, location.href);
    sendResponse(result);
  });
}
