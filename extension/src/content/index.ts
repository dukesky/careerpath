import { extractFromDocument, type ExtractResult } from "./extract";

/**
 * Injected on demand by the side panel via chrome.scripting. `executeScript`
 * re-executes this whole module every time useActiveJd reads the page — on
 * mount, on every tab activation, on every qualifying navigation — so without
 * a guard, the k-th read of a page leaves k listeners registered, each doing
 * a full `doc.cloneNode(true)` + Readability parse on every future message.
 * Twenty tab-switches back to one tab would mean twenty full-DOM clones per
 * message, growing without bound for the page's lifetime.
 *
 * A bare "already registered" boolean isn't safe here: if the extension is
 * reloaded or auto-updated while this tab stays open, the isolated world
 * this module runs in can outlive the reload — so a stale flag would keep
 * blocking registration forever, even though the listener it was guarding
 * belongs to an invalidated `chrome.runtime` and can no longer respond to
 * anything. We don't have a reliable signal that a reload happened:
 * `chrome.runtime.id` is stable by design (this manifest pins a key so the
 * extension ID doesn't drift), and nothing else observable from a content
 * script changes on every reload. So instead of trying to detect the
 * reload, we sidestep the need to: track the specific listener function we
 * last registered, unregister exactly that one (a harmless no-op if it's
 * already gone, or already belongs to a dead context), and register a fresh
 * one bound to *this* execution's — necessarily current and valid —
 * chrome.runtime. That keeps exactly one live listener across every case:
 * first injection into a page, a same-generation repeat injection, or a
 * post-reload re-injection into a world that never got torn down.
 */
type ExtractListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: ExtractResult) => void,
) => void;

const globalWithListener = globalThis as typeof globalThis & {
  __cpExtractListener?: ExtractListener;
};

if (globalWithListener.__cpExtractListener) {
  try {
    chrome.runtime.onMessage.removeListener(globalWithListener.__cpExtractListener);
  } catch {
    // The previous listener may belong to an already-invalidated extension
    // context (e.g. after a reload) — nothing left to clean up in that case.
  }
}

const listener: ExtractListener = (message, _sender, sendResponse) => {
  if ((message as { type?: unknown })?.type !== "CP_EXTRACT_JD") return;
  // Responding synchronously, so do NOT return true — that would tell Chrome
  // to hold the message channel open for an async reply that never comes.
  const result: ExtractResult = extractFromDocument(document, location.href);
  sendResponse(result);
};

globalWithListener.__cpExtractListener = listener;
chrome.runtime.onMessage.addListener(listener);
