import { API_BASE } from "./config";
import { ensureToken } from "./token";
import { currentAuthToken, type AuthToken } from "./session";
import { getBetaCode } from "./storage";

export type ApiErrorKind =
  | "quota"
  | "auth"
  | "session_expired"
  | "rate_limit"
  | "server"
  | "network";

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; kind: ApiErrorKind; message: string; retryAfter?: number };

const GENERIC_ERROR = "Something went wrong. Please try again.";

async function readMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body.error === "string" && body.error ? body.error : GENERIC_ERROR;
  } catch {
    return GENERIC_ERROR;
  }
}

function classify(status: number): ApiErrorKind {
  if (status === 401) return "auth";
  if (status === 402) return "quota";
  if (status === 429) return "rate_limit";
  return "server";
}

async function toFailure<T>(res: Response): Promise<ApiResult<T>> {
  const kind = classify(res.status);
  const message = await readMessage(res);
  if (kind === "rate_limit") {
    const raw = Number(res.headers.get("Retry-After"));
    return {
      ok: false,
      kind,
      message,
      ...(Number.isFinite(raw) && raw > 0 ? { retryAfter: raw } : {}),
    };
  }
  return { ok: false, kind, message };
}

/**
 * One request, carrying whichever identity currently applies.
 *
 * Before anything is sent: if `currentAuthToken` could not establish an
 * identity — Clerk reports the user signed in but hands back no token, or
 * the Clerk source itself failed — the request is refused with NO fetch.
 * Falling back to the device token here would spend a run against an
 * identity we can't attribute: the device token never 401s, so it would just
 * succeed against the 3-per-30-days bucket while the panel still shows a
 * signed-in user their daily allowance. See `session.ts` for why "we don't
 * know" must never collapse into "assume signed out".
 *
 * Otherwise, the 401 handling FORKS on the identity, and the fork is
 * load-bearing:
 *
 * - A device token is ours. Expiry is routine — mint another and retry ONCE.
 *   Never loop: a server that rejects a freshly minted token is broken, and
 *   retrying would hammer it.
 * - A Clerk token is the user's SESSION. There is nothing to mint. Refreshing
 *   here would fetch a device token, the retry would SUCCEED, and the user
 *   would silently continue as a signed-out device on 3 runs per 30 days
 *   while the panel still showed their email and their daily allowance. The
 *   quota on screen would be a lie and nothing would look broken. So: no
 *   refresh, no retry, and a distinct error kind the panel turns into
 *   "your session expired".
 */
async function send<T>(
  path: string,
  init: RequestInit,
  allowRefresh = true,
  overrideToken?: string,
): Promise<ApiResult<T>> {
  // An explicit token means the caller already settled identity and this
  // request must travel under it. The service worker uses this: it has no
  // Clerk session of its own, so the panel mints a run token and passes it
  // in. `currentAuthToken()` in the worker's realm always answers "device",
  // which is precisely the bug this parameter removes.
  //
  // It is treated as a `clerk` identity, not a `device` one, because that is
  // what it behaves like at the 401 fork below: it carries the user, and
  // nothing on this side can re-mint it.
  const auth: AuthToken | null = overrideToken
    ? { kind: "clerk", token: overrideToken }
    : await currentAuthToken();

  if (auth?.kind === "session_unavailable") {
    return {
      ok: false,
      kind: "session_expired",
      message: "We couldn't confirm your session. Sign in again to continue.",
    };
  }

  const headers: Record<string, string> = {
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (auth) headers.Authorization = `Bearer ${auth.token}`;

  // Independent of identity: the server's hasBetaAccess() reads only this
  // header and does not change who the caller IS, just what they are allowed
  // to spend. A signed-in beta tester stays a signed-in caller.
  const betaCode = await getBetaCode();
  if (betaCode) headers["x-access-code"] = betaCode;

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  } catch {
    return { ok: false, kind: "network", message: "Couldn't reach career-path." };
  }

  if (res.status === 401 && auth?.kind === "clerk") {
    return {
      ok: false,
      kind: "session_expired",
      message: "Your session expired. Sign in again to continue.",
    };
  }

  if (res.status === 401 && allowRefresh) {
    const refreshed = await ensureToken(true);
    if (refreshed) return send<T>(path, init, false, overrideToken);
  }

  if (!res.ok) return toFailure<T>(res);

  try {
    return { ok: true, data: (await res.json()) as T };
  } catch {
    return { ok: false, kind: "server", message: GENERIC_ERROR };
  }
}

/**
 * A GET through the same identity and 401 handling as every other call —
 * `send()` is where the Clerk-vs-device fork lives, so a GET that bypassed it
 * would report a different caller's quota than the POSTs it is describing.
 */
export function apiGet<T>(path: string, overrideToken?: string): Promise<ApiResult<T>> {
  return send<T>(path, { method: "GET" }, true, overrideToken);
}

export function apiPost<T>(
  path: string,
  body: unknown,
  overrideToken?: string,
): Promise<ApiResult<T>> {
  return send<T>(
    path,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    true,
    overrideToken,
  );
}

/** Multipart — do NOT set Content-Type; the browser adds the boundary. */
export function apiPostForm<T>(path: string, form: FormData): Promise<ApiResult<T>> {
  return send<T>(path, { method: "POST", body: form });
}
