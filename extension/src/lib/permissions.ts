/**
 * The optional host grant, and the one heuristic this feature depends on.
 */

/** Must stay identical to `optional_host_permissions` in manifest.config.ts. */
export const BROAD_ORIGINS = ["http://*/*", "https://*/*"];

/**
 * Why a `chrome.scripting.executeScript` call failed.
 *
 * HEURISTIC — string-matching a browser's error message is brittle, and this
 * is a deliberate stopgap. The robust signal is the tab's URL, but `tab.url`
 * is gated behind the very permission we are trying to obtain, so it is not
 * available at the moment we need to classify. Once the broad grant is held,
 * `tab.url` becomes readable everywhere and this should be rewritten against
 * it rather than against Chrome's wording.
 *
 * An unrecognised error defaults to "permission", the actionable case: at
 * worst the user is offered a grant that turns out not to help, which is
 * recoverable. Defaulting to "restricted" would strand them with no action.
 */
export function classifyInjectionError(err: unknown): "restricted" | "permission" {
  const text = err instanceof Error ? err.message : String(err ?? "");
  if (/chrome:\/\/|extensions gallery|chrome-extension:\/\//i.test(text)) {
    return "restricted";
  }
  return "permission";
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
