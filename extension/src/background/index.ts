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

// Each tab gets its OWN panel instance. Per Chrome's sidePanel docs, setting
// a path for a specific tabId yields a different instance than the default
// panel — which is what stops one posting's panel state from appearing under
// another. This deliberately does NOT look at the tab's URL: doing so would
// require the `tabs` permission, and disabling the panel on unrecognised
// sites would also remove the only route a user has to grant access to a new
// job board.
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id === undefined) return;
  void chrome.sidePanel
    .setOptions({ tabId: tab.id, path: "src/sidepanel/index.html", enabled: true })
    .catch((err) => console.warn("sidePanel.setOptions failed", err));
});

// Runs are owned by this worker so the panel can be closed, switched away
// from, or destroyed without killing one. `sendMessage` wakes this worker if
// it has been evicted, which is standard MV3 behaviour and needs no handling.
chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;
  if ((message as { type?: unknown }).type !== "start-run") return false;
  void startRun(message as StartRunMessage)
    .then(sendResponse)
    .catch((err) => {
      console.warn("startRun failed", err);
      // Answer anyway: a dead message channel gives the panel no way to tell
      // "refused" from "the worker fell over", and it would wait forever on
      // a promise that never resolves. `failed` rather than a borrowed
      // `at-capacity` — the panel now has a caller, and telling a user five
      // postings are generating when none are is a lie it can act on.
      sendResponse({ started: false, reason: "failed" });
    });
  // `true` keeps the message channel open for the async reply. Returning
  // anything else closes it and the caller's promise resolves undefined.
  return true;
});
