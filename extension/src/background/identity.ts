// The /background subpath, NOT /client. Its createClerkClient forces
// `background: true`, which returns a headless client that works with no DOM
// and calls `load({ standardBrowser: false })` on its own. Importing /client
// here would take the non-background branch, which dynamically imports
// @clerk/ui and needs a document — it fails only in a real browser, with
// every test still green.
import { createClerkClient } from "@clerk/chrome-extension/background";
import { CLERK_PUBLISHABLE_KEY } from "@/lib/config";
import { makeClerkTokenSource, type ClerkLike } from "@/lib/clerkTokenSource";
import { setClerkTokenSource } from "@/lib/session";

/**
 * A fragment of Clerk's own storage key, which is
 * `${frontendApi}|__clerk_client_jwt|v2` — the frontendApi half differs by
 * environment, so match on the stable middle rather than the whole key.
 *
 * If Clerk ever renames this internal constant the match silently stops
 * firing, and the cached client goes stale on sign-out. That degrades to the
 * server rejecting the stale token with a 401, which api.ts already turns
 * into `session_expired` — the existing correct behaviour, NOT a wrong
 * charge. That bounded downside is what makes a substring match acceptable
 * here rather than reaching into the SDK for the real key.
 */
const CLERK_JWT_KEY_FRAGMENT = "__clerk_client_jwt";

/**
 * The loaded client, memoized as a PROMISE so concurrent callers share one
 * `createClerkClient` rather than racing several.
 *
 * Cleared on rejection, NOT on success. A service worker can serve many runs
 * within one wake, so a single Clerk blip at cold start must not refuse every
 * request for the rest of that worker's life — the panel's client carries the
 * same reset for the same reason.
 */
let clerkPromise: Promise<ClerkLike> | undefined;

function getBackgroundClerk(): Promise<ClerkLike> {
  if (!clerkPromise) {
    // Deliberately NOT followed by a load() call: createClerkClient resolves
    // only after it has loaded the client itself.
    const pending: Promise<ClerkLike> = createClerkClient({
      publishableKey: CLERK_PUBLISHABLE_KEY,
    }).catch((err: unknown) => {
      // Retract ONLY this promise. A sign-out can land while a create is
      // still in flight: the storage listener clears the slot, a later call
      // fills it with a fresh client, and this rejection arrives last. An
      // unconditional clear here would throw that newer, valid client away
      // and cost the next caller a needless load() round trip.
      if (clerkPromise === pending) clerkPromise = undefined;
      throw err;
    });
    clerkPromise = pending;
  }
  return clerkPromise;
}

/**
 * Gives the service worker the same identity the panel has.
 *
 * Without this, `session.ts`'s module-level `clerkTokenSource` keeps its
 * signed-out default in the worker's realm — a separate JS realm from the
 * panel's — and every background run transacts as the device rather than as
 * the signed-in user, spending the 3-per-30-days device trial while the
 * user's own daily count never moves.
 *
 * Cheap to call at module scope: the Clerk client itself is created lazily,
 * on the first request for a token.
 */
export function installBackgroundClerkTokenSource(): void {
  setClerkTokenSource(makeClerkTokenSource(getBackgroundClerk));

  // Sign-out, sign-in, and token refresh all land as a write to Clerk's JWT
  // key in storage.local, which the panel, the sign-in page and this worker
  // all share. Watching it is what keeps a client cached here from outliving
  // the session it represents, with no message passing.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    for (const key of Object.keys(changes)) {
      if (key.includes(CLERK_JWT_KEY_FRAGMENT)) {
        clerkPromise = undefined;
        return;
      }
    }
  });
}
