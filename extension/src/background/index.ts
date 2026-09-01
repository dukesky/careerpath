import { ensureToken } from "@/lib/token";
import { startRun, type StartRunMessage } from "./runs";
import { installBackgroundClerkTokenSource } from "./identity";
// TEMPORARY: see the diagnostic block at the end of this file.
import { clearRunLog, dumpRunLog } from "@/lib/runLog";

/**
 * Opens the side panel when the toolbar icon is clicked, and keeps a device
 * token warm so the panel never blocks on minting one.
 */

// Module scope, so the worker has an identity before any message handler can
// run — including the cold start where the wake IS a start-run message. It
// costs nothing here: the Clerk client is created lazily, on the first
// request for a token. Without this call, session.ts's signed-out default
// stands in this realm and every background run is a device run.
installBackgroundClerkTokenSource();

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.warn("sidePanel.setPanelBehavior failed", err));

/**
 * Give every tab that already exists its own panel instance.
 *
 * `tabs.onCreated` below only covers tabs opened from now on, so without this
 * every tab open at install, at update, or before a worker cold start stays on
 * the shared window-global panel — including, most likely, the job posting the
 * user was looking at when they installed the extension.
 *
 * `query({})` needs no `tabs` permission: it returns the tabs with `url`
 * stripped, and only `id` is read here. Do not add a url filter — that would
 * require the permission this extension deliberately does not request.
 */
async function giveExistingTabsTheirOwnPanel(): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({});
    await Promise.all(
      tabs.map((tab) =>
        tab.id === undefined
          ? Promise.resolve()
          : chrome.sidePanel
              .setOptions({ tabId: tab.id, path: "src/sidepanel/index.html", enabled: true })
              .catch((err) => console.warn("sidePanel.setOptions failed", err)),
      ),
    );
  } catch (err) {
    console.warn("tabs.query failed", err);
  }
}

// Mint on install and refresh on every browser start. The token lasts 24h, so
// a startup refresh covers any session shorter than a day; the API client's
// 401 retry covers the rest. Also backfill existing tabs here: install and
// startup are the two points where the worker knows it is starting fresh and
// may be looking at tabs `onCreated` never fired for.
chrome.runtime.onInstalled.addListener(() => {
  void ensureToken();
  void giveExistingTabsTheirOwnPanel();
});

chrome.runtime.onStartup.addListener(() => {
  void ensureToken(true);
  void giveExistingTabsTheirOwnPanel();
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

// TEMPORARY: diagnostic access to the run breadcrumb trail, for the MV3
// service-worker lifetime question. Attaching DevTools to a service worker
// prevents Chrome from evicting it, so the failure cannot be observed live —
// the trail is written to storage during the run and read back here
// afterwards, from a console that was never attached while it mattered.
//
// Usage, in the service worker console AFTER a failed run:
//   await cpDumpRunLog()
//
// Remove together with lib/runLog.ts once this is settled.
(globalThis as unknown as { cpDumpRunLog: () => Promise<string> }).cpDumpRunLog =
  async () => dumpRunLog();
(globalThis as unknown as { cpClearRunLog: () => Promise<void> }).cpClearRunLog =
  async () => clearRunLog();
