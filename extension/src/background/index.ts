import { ensureToken } from "@/lib/token";

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
