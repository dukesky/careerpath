import { API_BASE } from "./config";
import { getToken, setToken } from "./storage";

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

  try {
    const res = await fetch(`${API_BASE}/api/device-token`, { method: "POST" });
    if (!res.ok) return null;
    const body = (await res.json()) as { token?: unknown };
    if (typeof body.token !== "string" || !body.token) return null;
    await setToken(body.token);
    return body.token;
  } catch {
    // Offline or blocked. The panel degrades to an anonymous caller.
    return null;
  }
}
