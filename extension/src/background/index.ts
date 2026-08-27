import { ensureToken } from "@/lib/token";
import { startRun, type StartRunMessage } from "./runs";

/**
 * Opens the side panel when the toolbar icon is clicked, and keeps a device
 * token warm so the panel never blocks on minting one.
 */

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.warn("sidePanel.setPanelBehavior failed", err));

// Mint on install and refresh on every browser start. The token lasts 24h, so
// a startup refresh covers any session shorter than a day; the API client's
// 401 retry covers the rest.
chrome.runtime.onInstalled.addListener(() => {
  void ensureToken();
});

chrome.runtime.onStartup.addListener(() => {
  void ensureToken(true);
});

// Runs are owned by this worker so the panel can be closed, switched away
// from, or destroyed without killing one. `sendMessage` wakes this worker if
// it has been evicted, which is standard MV3 behaviour and needs no handling.
chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;
  if ((message as { type?: unknown }).type !== "start-run") return false;
  void startRun(message as StartRunMessage).then(sendResponse);
  // `true` keeps the message channel open for the async reply. Returning
  // anything else closes it and the caller's promise resolves undefined.
  return true;
});
