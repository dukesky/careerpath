import { ensureToken } from "./token";

/**
 * Which identity a request travels under.
 *
 * The extension has two real identities, and they behave differently on
 * failure — which is the whole reason this type exists rather than a bare
 * string. A device token is ours: it expires, we mint another, the user
 * never knows. A Clerk token is the user's session: when it goes, nothing
 * can be minted in its place and the user has to be told.
 *
 * `session_unavailable` is not an identity — it is what `currentAuthToken`
 * returns when it cannot tell which of the two applies (Clerk says the user
 * is signed in but has no token to give, or the Clerk source itself failed).
 * Collapsing that uncertainty into a silent fallback to the device token was
 * a bug: the device token never 401s, so the request would just succeed
 * against the wrong quota bucket. See `currentAuthToken` below.
 */
export type AuthToken =
  | { kind: "clerk"; token: string }
  | { kind: "device"; token: string }
  | { kind: "session_unavailable" };

/**
 * What the Clerk layer knows right now.
 *
 * `{ signedIn: false }` and `{ signedIn: true, token: null }` are NOT the same
 * thing, and collapsing them into a bare `string | null` is what let a
 * signed-in user fall through to the device identity and spend a trial they
 * could not see. The source is expected to have awaited Clerk's load before
 * answering — see lib/clerk.ts — so "signed in with no token" means something
 * is wrong, not "still starting up".
 */
export type ClerkAuthState =
  | { signedIn: false }
  | { signedIn: true; token: string | null };

export type ClerkTokenSource = () => Promise<ClerkAuthState>;

/**
 * Injected rather than imported so this module — and the 401 fork that
 * depends on it — is testable without Clerk, and so the panel does not pull
 * Clerk's bundle in just by importing the API client. `lib/clerk.ts` installs
 * the real source; until it does, every caller is a device caller.
 */
let clerkTokenSource: ClerkTokenSource = async () => ({ signedIn: false });

export function setClerkTokenSource(source: ClerkTokenSource): void {
  clerkTokenSource = source;
}

export async function currentAuthToken(): Promise<AuthToken | null> {
  let state: ClerkAuthState;
  try {
    state = await clerkTokenSource();
  } catch (err) {
    // Clerk unreachable. We cannot tell whether this user is signed in, and
    // falling back to the device token here is exactly the silent downgrade
    // this module exists to prevent: the device token never 401s, so the
    // request would just succeed against the 3-per-30-days bucket while the
    // panel still shows a signed-in user their daily allowance. Report the
    // uncertainty instead of guessing "signed out" on the user's behalf, and
    // let the caller (api.ts) refuse the request outright.
    console.warn(
      JSON.stringify({
        evt: "clerk_source_threw",
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    return { kind: "session_unavailable" };
  }

  if (state.signedIn) {
    if (state.token) return { kind: "clerk", token: state.token };
    // Signed in, and Clerk says so, but there is no token to send. Something
    // is wrong with the session — do not guess "signed out" and spend the
    // user's device trial in its place.
    return { kind: "session_unavailable" };
  }

  const device = await ensureToken();
  return device ? { kind: "device", token: device } : null;
}
