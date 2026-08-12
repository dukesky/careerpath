/**
 * The optional host grant, and the one heuristic this feature depends on.
 */

/** Must stay identical to `optional_host_permissions` in manifest.config.ts. */
export const BROAD_ORIGINS = ["http://*/*", "https://*/*"];

/**
 * Why a `chrome.scripting.executeScript` or `chrome.tabs.sendMessage` call
 * failed.
 *
 * HEURISTIC — string-matching a browser's error message is brittle, and this
 * is a deliberate stopgap. The robust signal is the tab's URL, but `tab.url`
 * is gated behind the very permission we are trying to obtain, so it is not
 * available at the moment we need to classify. Once the broad grant is held,
 * `tab.url` becomes readable everywhere and this should be rewritten against
 * it rather than against Chrome's wording.
 *
 * This does NOT default an unrecognised error to "permission" anymore.
 * "permission" is gated on the broadest grant the extension can ask for —
 * offering it for a problem that grant cannot fix (e.g. "Could not establish
 * connection. Receiving end does not exist.", a real failure mode when a
 * read races a navigation, on a host we already have access to via
 * host_permissions) talks the user into "read every website you visit" for
 * nothing, and once granted, hides the button entirely — a dead end. Only
 * Chrome's actual host-permission wording earns the offer; everything else
 * is "unknown".
 */
export function classifyInjectionError(
  err: unknown,
): "restricted" | "permission" | "unknown" {
  const text = err instanceof Error ? err.message : String(err ?? "");
  // Schemes chrome.permissions.request cannot grant access to, no matter
  // what the user approves: chrome:// and the Web Store are simply
  // unscriptable; file://, view-source:, and about: pages need a separate
  // Chrome "Allow access to file URLs" checkbox the extension cannot request
  // programmatically. Offering the broad-origin grant here would fail
  // identically after the user granted it, and cost them the button.
  if (
    /chrome:\/\/|extensions gallery|chrome-extension:\/\/|file:\/\/|view-source:|about:/i.test(
      text,
    )
  ) {
    return "restricted";
  }
  if (/cannot access contents of the page|must request permission to access/i.test(text)) {
    return "permission";
  }
  return "unknown";
}

export async function hasBroadHostAccess(): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ origins: BROAD_ORIGINS });
  } catch {
    // Unavailable or rejected — treat as not granted. The panel then offers
    // the button, and the request itself will surface any real problem.
    return false;
  }
}

/** MUST be called from a user gesture; Chrome rejects it otherwise. */
export async function requestBroadHostAccess(): Promise<boolean> {
  try {
    return await chrome.permissions.request({ origins: BROAD_ORIGINS });
  } catch {
    return false;
  }
}
