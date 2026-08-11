import { extractFromDocument, type ExtractResult } from "./extract";

/**
 * Injected on demand by the side panel via chrome.scripting, so it only ever
 * runs on a tab the user explicitly asked us to read. It answers one message
 * and holds no state.
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "CP_EXTRACT_JD") return;
  // Responding synchronously, so do NOT return true — that would tell Chrome
  // to hold the message channel open for an async reply that never comes.
  const result: ExtractResult = extractFromDocument(document, location.href);
  sendResponse(result);
});
