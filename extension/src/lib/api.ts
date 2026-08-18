import { API_BASE } from "./config";
import { ensureToken } from "./token";
import { currentAuthToken } from "./session";

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
 * The 401 handling FORKS on that identity, and the fork is load-bearing:
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
): Promise<ApiResult<T>> {
  const auth = await currentAuthToken();
  const headers: Record<string, string> = {
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (auth) headers.Authorization = `Bearer ${auth.token}`;

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
    if (refreshed) return send<T>(path, init, false);
  }

  if (!res.ok) return toFailure<T>(res);

  try {
    return { ok: true, data: (await res.json()) as T };
  } catch {
    return { ok: false, kind: "server", message: GENERIC_ERROR };
  }
}

export function apiPost<T>(path: string, body: unknown): Promise<ApiResult<T>> {
  return send<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Multipart — do NOT set Content-Type; the browser adds the boundary. */
export function apiPostForm<T>(path: string, form: FormData): Promise<ApiResult<T>> {
  return send<T>(path, { method: "POST", body: form });
}
