import { apiPost } from "./api";
import { isSignedIn } from "./clerk";
import { getHasSignedIn } from "./storage";
import type { ApiErrorKind } from "./api";

/**
 * The identity a background run should transact under.
 *
 * Three outcomes, deliberately distinct — collapsing any two of them
 * reintroduces a silent downgrade:
 *
 * - `null`      — not signed in. The run proceeds on the device identity,
 *                 exactly as it always has. Signing in is an upgrade, never
 *                 a gate.
 * - `{ok:true}` — a token the worker can run under.
 * - `{ok:false}`— signed in, but no token could be minted. The caller must
 *                 REFUSE to start rather than fall back to the device
 *                 identity: that fallback would succeed, spend the 3-per-30-
 *                 days trial, and leave the panel showing a signed-in user
 *                 their daily allowance while the run billed elsewhere.
 */
export type RunTokenResult =
  | { ok: true; token: string }
  | { ok: false; kind: ApiErrorKind; message: string };

export async function fetchRunToken(): Promise<RunTokenResult | null> {
  let signedIn: boolean;
  try {
    signedIn = await isSignedIn();
  } catch {
    // `isSignedIn` awaits Clerk's `load()`, which rejects whenever Clerk's
    // Frontend API cannot be reached — an incident, a paused instance, a
    // proxy that blocks the host. Without this fork that rejection would
    // travel out of here and out of the panel's `generate`, and a user who
    // has NEVER signed in would be told their run could not start because of
    // an outage at a service they have no relationship with. Anonymous use
    // predates sign-in and must survive it.
    //
    // Which way the fork goes is not a matter of taste. This is the same rule
    // lib/clerkTokenSource.ts holds for the per-request path, and the two must
    // keep answering identically — read its doc comment before changing
    // either. Both hinge on the one durable fact available without Clerk: has
    // this browser ever signed in?
    //
    //   No  -> there is no session to protect, so answer as an anonymous
    //          caller always did and let the run proceed on the device
    //          identity.
    //   Yes -> we cannot tell whether the session is still good, and guessing
    //          "signed out" would quietly spend this user's 3-per-30-days
    //          device trial while the panel showed them their daily
    //          allowance. Report the uncertainty and let the panel refuse.
    if (!(await getHasSignedIn())) return null;
    return {
      ok: false,
      kind: "session_expired",
      // Deliberately the wording lib/api.ts uses for the same condition, so
      // one problem reads as one sentence however the user reaches it.
      message: "We couldn't confirm your session. Sign in again to continue.",
    };
  }
  if (!signedIn) return null;

  const res = await apiPost<{ token?: unknown }>("/api/run-token", {});
  if (!res.ok) return { ok: false, kind: res.kind, message: res.message };

  const token = res.data.token;
  if (typeof token !== "string" || !token) {
    // A 200 with nothing usable in it. Reported as a failure rather than
    // returned as an empty token, which would travel as `Bearer ` and come
    // back a confusing 401 from the far side of three API calls.
    return {
      ok: false,
      kind: "server",
      message: "Couldn't confirm your session. Try again.",
    };
  }
  return { ok: true, token };
}
