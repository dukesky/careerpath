import { API_BASE } from "./config";
import { getToken, setToken } from "./storage";

/**
 * Actually mints a device token from the server. `/api/device-token` issues a
 * fresh `crypto.randomUUID()` device identity on every call, so this must
 * only ever be in flight once at a time — see `inflight` below.
 */
async function mint(): Promise<string | null> {
  let token: string;
  try {
    const res = await fetch(`${API_BASE}/api/device-token`, { method: "POST" });
    if (!res.ok) return null;
    const body = (await res.json()) as { token?: unknown };
    if (typeof body.token !== "string" || !body.token) return null;
    token = body.token;
  } catch {
    // Offline or blocked. The panel degrades to an anonymous caller.
    return null;
  }
  // Store outside the fetch's try/catch: a storage failure here must not make
  // us report `null` and have the caller treat itself as anonymous when the
  // server already handed us a perfectly valid token. But a storage failure
  // must not make us REJECT either — ensureToken has no caller that catches
  // (api.ts's `send` awaits it outside its try, and background/index.ts calls
  // it via `void`), so an unwrapped rejection here would surface as a silent,
  // uncaught panel failure or an unhandled rejection in the service worker
  // instead of the working (if unpersisted) token we already have in hand.
  try {
    await setToken(token);
  } catch {
    // Not persisted — this token is still valid for the rest of this
    // session, and returning it beats forcing an anonymous run or failing
    // the click.
  }
  return token;
}

// Concurrent callers must share ONE mint. run.ts fires analyze and tailor in
// parallel; if the shared token were rejected mid-run (expiry, a secret
// rotation, the background worker's onStartup remint overwriting storage),
// both legs would independently call ensureToken(true) and the server would
// issue two device ids. The two retried legs would then carry different
// deviceIds, land in different quota buckets, and one run would be charged
// twice. Memoizing the in-flight promise makes two concurrent
// ensureToken(true) calls resolve to exactly one POST /api/device-token.
let inflight: Promise<string | null> | null = null;

/**
 * Device tokens are server-signed and last 24h. We do not decode or check the
 * expiry here: the API answers a stale token with 401, and the API client
 * turns that into exactly one forced refresh. One source of truth for
 * validity — the server — beats two that can disagree.
 */
export async function ensureToken(force = false): Promise<string | null> {
  if (!force) {
    const existing = await getToken();
    if (existing) return existing;
  }

  if (inflight) return inflight;
  inflight = mint();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}
