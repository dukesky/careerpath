import { createClerkClient } from "@clerk/chrome-extension/client";
import { CLERK_PUBLISHABLE_KEY } from "./config";
import { setClerkTokenSource } from "./session";

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
 */
let clerkPromise: Promise<ClerkClient> | undefined;

function load(): Promise<ClerkClient> {
  if (!clerkPromise) {
    clerkPromise = (async () => {
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
    })();
  }
  return clerkPromise;
}

/** The loaded singleton. Every other export in this module is built on it. */
export function getClerk(): Promise<ClerkClient> {
  return load();
}

/**
 * Wires this module's Clerk client into session.ts as the source api.ts
 * consults for every request. Call once, from wherever the panel bootstraps
 * (Task 5) — NOT from here, and NOT from the sign-in page, which has no
 * reason to touch api.ts's auth path.
 *
 * The source function itself:
 *
 * 1. Awaits `getClerk()` — i.e. awaits `load()` — before answering, on
 *    EVERY call, not just the first. `getClerk` returns the same memoized
 *    promise to every caller, so this never races `load()`; a call made
 *    before `load()` resolves simply waits, rather than answering early off
 *    a not-yet-populated `session`/`isSignedIn`. That is required, not
 *    incidental: session.ts's contract only treats "signed in, no token" as
 *    a real failure because the source has already waited out Clerk's
 *    hydration — see session.ts's `ClerkAuthState` doc comment. A source
 *    that could answer before `load()` finished would turn every fast click
 *    right after the panel opens into a spurious session_unavailable.
 * 2. Never reports `{ signedIn: false }` for a user who IS signed in. If
 *    `client.isSignedIn` is true but `session` is missing or `getToken()`
 *    resolves null, this reports `{ signedIn: true, token: null }` — the
 *    state session.ts turns into `session_unavailable`, not a silent
 *    downgrade to the device identity. Collapsing the two was the exact bug
 *    that made session.ts's `ClerkAuthState` type exist in the first place.
 */
export function installClerkTokenSource(): void {
  setClerkTokenSource(async () => {
    const client = await getClerk();
    if (!client.isSignedIn) return { signedIn: false };
    const token = client.session ? await client.session.getToken() : null;
    return { signedIn: true, token };
  });
}

export async function currentUserEmail(): Promise<string | null> {
  const client = await getClerk();
  return client.user?.primaryEmailAddress?.emailAddress ?? null;
}

export async function isSignedIn(): Promise<boolean> {
  const client = await getClerk();
  return client.isSignedIn;
}

export async function signOut(): Promise<void> {
  const client = await getClerk();
  await client.signOut({ redirectUrl: signInUrl() });
}

export function signInPageUrl(): string {
  return signInUrl();
}
