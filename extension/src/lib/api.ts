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
 * How a successful response's body becomes a result.
 *
 * `send` owns identity, the 401 fork and status-code mapping; the ONLY thing
 * that differs between a buffered call and a streamed one is this last step,
 * so it is a parameter rather than a second copy of `send`. Everything above
 * it — including the device-token refresh-and-retry, which re-issues the whole
 * request — therefore behaves identically for both.
 */
type Consume<T> = (res: Response) => Promise<ApiResult<T>>;

async function readJson<T>(res: Response): Promise<ApiResult<T>> {
  try {
    return { ok: true, data: (await res.json()) as T };
  } catch {
    return { ok: false, kind: "server", message: GENERIC_ERROR };
  }
}

/**
 * Reads an SSE body, handing each `d` delta to `onDelta` and resolving with the
 * `final` frame's payload — which is byte-identical to the buffered response
 * body for the same request.
 *
 * Frame contract (src/lib/sse.ts, verbatim):
 *   data: {"d":"<text delta>"}   repeated
 *   data: {"final":<body>}
 *   data: [DONE]
 * and, on failure, data: {"error":"<bare message>"} with no [DONE].
 *
 * NO retry of any kind lives here. A stream that ends without a final frame is
 * a plain failure, and what to do about it — for this product, one buffered
 * attempt at the same leg — is the caller's decision, because only the caller
 * knows whether the leg is worth spending again. See run.ts.
 */
async function readStream<T>(
  res: Response,
  onDelta: (chunk: string) => void,
): Promise<ApiResult<T>> {
  if (!res.body) return { ok: false, kind: "server", message: GENERIC_ERROR };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let final: T | undefined;
  let haveFinal = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // A frame is only a frame once its blank line has arrived. Chunk
      // boundaries fall wherever the transport likes, so anything after the
      // last "\n\n" stays in the buffer for the next read.
      let split: number;
      while ((split = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        if (!frame.startsWith("data: ")) continue;
        const payload = frame.slice(6);
        if (payload === "[DONE]") continue;

        let parsed: { d?: unknown; final?: T; error?: unknown };
        try {
          parsed = JSON.parse(payload);
        } catch {
          // One unreadable frame must not cost us the final frame behind it.
          continue;
        }
        if (typeof parsed.d === "string") onDelta(parsed.d);
        else if (parsed.final !== undefined) {
          final = parsed.final;
          haveFinal = true;
        } else if (typeof parsed.error === "string" && parsed.error) {
          // The message is the server's, bare — it is not wrapped here because
          // the caller decides how a streamed failure is surfaced, if at all.
          return { ok: false, kind: "server", message: parsed.error };
        }
      }
    }
  } catch {
    // The socket died mid-stream. Network, not server: nothing answered.
    return { ok: false, kind: "network", message: "Couldn't reach career-path." };
  }

  if (!haveFinal) {
    return { ok: false, kind: "server", message: "The result never finished arriving." };
  }
  return { ok: true, data: final as T };
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
 *
 * `overrideToken` lets a caller — the service worker, which has no Clerk
 * session of its own — pin the identity explicitly instead of consulting
 * `currentAuthToken()`. It is folded into the `clerk` branch of the fork
 * above, not the `device` one: it carries the user, nothing on this side can
 * re-mint it, and a rejection must fail loudly rather than silently retry as
 * a device.
 */
async function send<T>(
  path: string,
  init: RequestInit,
  allowRefresh = true,
  overrideToken?: string,
  consume: Consume<T> = readJson,
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
  //
  // This MUST be a presence check (`!== undefined`), not a truthy check. An
  // empty-string override is a caller bug, but falling through to
  // `currentAuthToken()` for it would silently downgrade to the device
  // identity — the exact bug this parameter exists to remove, just reached
  // through `""` instead of an omitted argument. Keeping it as `clerk` means
  // an empty override sends `Bearer ` and comes back a loud 401
  // `session_expired`, not a quiet device-bucket charge.
  const auth: AuthToken | null =
    overrideToken !== undefined
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
    if (refreshed) return send<T>(path, init, false, overrideToken, consume);
  }

  if (!res.ok) return toFailure<T>(res);

  return consume(res);
}

/**
 * A GET through the same identity and 401 handling as every other call —
 * `send()` is where the Clerk-vs-device fork lives, so a GET that bypassed it
 * would report a different caller's quota than the POSTs it is describing.
 * `overrideToken` is threaded through to `send()` unchanged; see its doc
 * comment for why an override is pinned as a `clerk` identity.
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

/**
 * A POST whose response is read as a stream of deltas instead of one body.
 *
 * Identity, the 401 fork, and status-code mapping are `send`'s, unchanged: a
 * streamed leg spends the same quota as a buffered one and must travel under
 * the same caller. `overrideToken` behaves exactly as it does on apiPost.
 *
 * The result type is the SAME `T` the buffered call returns, because the final
 * frame carries the buffered body verbatim — which is what lets a caller fall
 * back to `apiPost` for the same leg without a second shape to handle.
 *
 * `onDelta` is presentation. It is called with raw model text, in order, and
 * may be called zero times for a successful result.
 */
export function apiStream<T>(
  path: string,
  body: unknown,
  onDelta: (chunk: string) => void,
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
    (res) => readStream<T>(res, onDelta),
  );
}

/** Multipart — do NOT set Content-Type; the browser adds the boundary. */
export function apiPostForm<T>(path: string, form: FormData): Promise<ApiResult<T>> {
  return send<T>(path, { method: "POST", body: form });
}
