import type { ClerkAuthState, ClerkTokenSource } from "./session";
import { getHasSignedIn, setHasSignedIn } from "./storage";

/**
 * The structural subset of Clerk's client this module needs.
 *
 * Declared structurally rather than imported from the SDK so this module
 * pulls in no Clerk code at all — which is what lets the service worker share
 * it with the panel without dragging in the panel's DOM-bound client.
 */
export interface ClerkLike {
  isSignedIn: boolean;
  session: { getToken: () => Promise<string | null> } | null | undefined;
}

/**
 * The three-state contract api.ts depends on, in ONE place.
 *
 * There are two callers — the panel (lib/clerk.ts) and the service worker
 * (background/identity.ts) — and they differ ONLY in how they obtain a
 * client. The behaviour below must not differ between them, and duplicating
 * it in the worker is how it would come to: this repository has been bitten
 * three times by one rule written down in two files with nothing pinning them
 * together.
 *
 * The behaviour itself:
 *
 * 1. Never reports `{ signedIn: false }` for a user who IS signed in. If
 *    `isSignedIn` is true but `session` is missing or `getToken()` resolves
 *    null, this reports `{ signedIn: true, token: null }` — the state
 *    session.ts turns into `session_unavailable`, not a silent downgrade to
 *    the device identity. Collapsing the two was the exact bug that made
 *    session.ts's `ClerkAuthState` type exist.
 *
 * 2. Answers WITHOUT Clerk when the client cannot be obtained and this
 *    browser has never signed in. That asymmetry is the point, not a
 *    shortcut: a browser with no session has nothing to protect, and
 *    rethrowing would take the extension away from the entire anonymous user
 *    base for the duration of a Clerk outage they have no relationship with.
 *    A browser that HAS signed in gets the rethrow, because guessing "signed
 *    out" would spend that user's device trial while the panel still showed
 *    their email and daily allowance.
 *
 * `getClient` is expected to have awaited Clerk's load before resolving, so
 * "signed in with no token" means something is wrong rather than "still
 * starting up" — see session.ts's ClerkAuthState doc comment.
 */
export function makeClerkTokenSource(
  getClient: () => Promise<ClerkLike>,
): ClerkTokenSource {
  return async (): Promise<ClerkAuthState> => {
    let client: ClerkLike;
    try {
      client = await getClient();
    } catch (err) {
      if (await getHasSignedIn()) throw err;
      return { signedIn: false };
    }
    if (!client.isSignedIn) return { signedIn: false };
    // Recorded here as well as in clerk.ts's `isSignedIn` because this is the
    // path that runs on every request; a user who signs in and immediately
    // runs must have the flag set before the next Clerk failure.
    await setHasSignedIn();
    const token = client.session ? await client.session.getToken() : null;
    return { signedIn: true, token };
  };
}
