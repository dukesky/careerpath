/**
 * A TYPE-only import, with the value pulled in by a dynamic `import()` inside
 * `createAndLoad` below. `import type` is erased at compile time, so it adds
 * no edge to the module graph — which is the whole point: three components in
 * the panel (App, AccountBar, SaveButton) import this module statically, and
 * a static value import here put Clerk's ~844 kB SDK chunk into the side
 * panel's entry HTML as a modulepreload, paid for by every user on every
 * panel open including one who never signs in. The plan's stated architecture
 * was "keep Clerk's bundle off the panel's open path"; the vanilla-client
 * choice was necessary for that but not sufficient, because a static import
 * of the vanilla client is still a static import.
 *
 * Chosen over `Awaited<ReturnType<typeof import(...)>["createClerkClient"]>`
 * because it keeps `ClerkClient` reading exactly as it did before, and keeps
 * the overload note below meaningful.
 */
import type { createClerkClient } from "@clerk/chrome-extension/client";
import { CLERK_PUBLISHABLE_KEY } from "./config";
import { makeClerkTokenSource } from "./clerkTokenSource";
import { setClerkTokenSource } from "./session";
import { setHasSignedIn } from "./storage";

/**
 * `createClerkClient` is overloaded: pass `background: true` and it returns
 * `Promise<Clerk>` for the service worker's headless client; omit it (as we
 * do here — this module runs in the sign-in page, an ordinary tab, not the
 * background) and it returns a `Clerk` instance synchronously, unloaded.
 * `ReturnType` on an overloaded function resolves to the LAST signature,
 * which is exactly this non-background one — verified by reading
 * `@clerk/chrome-extension/dist/types/utils/clerk-client.d.ts` rather than
 * assumed, since the type is not otherwise exported from the package's
 * public surface.
 */
type ClerkClient = ReturnType<typeof createClerkClient>;

/**
 * The sign-in page's own URL. `load()`'s redirect options and `signOut()`
 * both need it, and Task 5's panel needs it too (`signInPageUrl`) to open
 * this page in a tab. One function, not a repeated literal, so the emitted
 * path only has to be right in one place — see vite.config.ts for where
 * that path is declared as a build input.
 */
function signInUrl(): string {
  return chrome.runtime.getURL("src/signin/index.html");
}

/**
 * Memoized so concurrent callers — the sign-in page's own script and, later,
 * anything in the panel that calls `getClerk`/`installClerkTokenSource` —
 * share exactly one `createClerkClient` + `load()`, not one each. `load()`
 * is not idempotent-cheap: it talks to Clerk's Frontend API.
 *
 * The promise is stored, not just the resolved client: every caller of
 * `getClerk` awaits THIS promise, so nobody can observe the client before
 * `load()` has resolved. That is what lets `installClerkTokenSource`'s
 * source function report "signed in, no token" as a real problem instead of
 * "still starting up" — see session.ts's `ClerkAuthState` doc comment for
 * why that distinction is the whole point of this task's contract change.
 *
 * Cleared on rejection (see the `.catch` below), NOT on success. The panel
 * is long-lived — this promise can outlive many requests — so a `load()`
 * that fails once (Clerk's Frontend API unreachable for a moment at panel
 * startup) must not poison every later call for the rest of the page's
 * life. Without the reset, `installClerkTokenSource`'s source would throw
 * on every subsequent call, `session.ts` would report `session_unavailable`
 * forever, and `api.ts` would refuse every request until the panel was
 * closed and reopened — a transient blip turned permanent. The success path
 * still memoizes the resolved client normally, so concurrent callers keep
 * sharing one `load()`.
 */
let clerkPromise: Promise<ClerkClient> | undefined;

async function createAndLoad(): Promise<ClerkClient> {
  // The one place Clerk's SDK is actually pulled in — see the type-only
  // import at the top of this file. Everything that reaches Clerk goes
  // through `load()` -> here, so nothing before this point costs the panel
  // the SDK's download and parse.
  const { createClerkClient } = await import("@clerk/chrome-extension/client");
  const client = createClerkClient({ publishableKey: CLERK_PUBLISHABLE_KEY });
  const url = signInUrl();
  await client.load({
    afterSignOutUrl: url,
    signInForceRedirectUrl: url,
    signUpForceRedirectUrl: url,
    // NOT optional: without this the OAuth leg (Google) cannot redirect
    // back into a chrome-extension:// URL and sign-in fails at its last
    // step. Verified against @clerk/shared's ClerkOptions type, which
    // does include allowedRedirectProtocols — the brief's assumption
    // held here.
    allowedRedirectProtocols: ["chrome-extension:"],
  });
  return client;
}

function load(): Promise<ClerkClient> {
  if (!clerkPromise) {
    clerkPromise = createAndLoad().catch((err: unknown) => {
      clerkPromise = undefined;
      throw err;
    });
  }
  return clerkPromise;
}

/** The loaded singleton. Every other export in this module is built on it. */
export function getClerk(): Promise<ClerkClient> {
  return load();
}

/**
 * Wires this module's Clerk client into session.ts as the source api.ts
 * consults for every request. Call once, from wherever the panel bootstraps —
 * NOT from the sign-in page, which has no reason to touch api.ts's auth path.
 *
 * The behaviour lives in lib/clerkTokenSource.ts, and this is its only
 * caller — the service worker has no Clerk client of its own and cannot be
 * given one, so a background run travels under a token the panel mints (see
 * lib/runToken.ts). Read that module's doc comment before changing anything
 * here: this file supplies only the client, never the rules, and the rule for
 * an unreachable Clerk is deliberately asymmetric.
 */
export function installClerkTokenSource(): void {
  setClerkTokenSource(makeClerkTokenSource(getClerk));
}

export async function currentUserEmail(): Promise<string | null> {
  const client = await getClerk();
  return client.user?.primaryEmailAddress?.emailAddress ?? null;
}

export async function isSignedIn(): Promise<boolean> {
  const client = await getClerk();
  // The panel calls this on mount and on every visibilitychange, so it is
  // the earliest and most frequent point at which "this browser has a Clerk
  // session" becomes known — record it, so that a LATER Clerk outage is
  // treated as protecting a real session rather than as an anonymous user's
  // first ever request. See lib/storage.ts's HAS_SIGNED_IN_KEY.
  if (client.isSignedIn) await setHasSignedIn();
  return client.isSignedIn;
}

export async function signOut(): Promise<void> {
  const client = await getClerk();
  await client.signOut({ redirectUrl: signInUrl() });
}

export function signInPageUrl(): string {
  return signInUrl();
}
