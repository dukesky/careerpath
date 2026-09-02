import { apiPost } from "./api";
import { isSignedIn } from "./clerk";
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
  if (!(await isSignedIn())) return null;

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
