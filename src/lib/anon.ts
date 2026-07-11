// Client-side anonymous id: generated once, persisted in localStorage, and
// sent with API requests so the server can attribute anonymous quota.
export const ANON_HEADER = "x-anon-id";
export const ACCESS_HEADER = "x-access-code";

const STORAGE_KEY = "cp_anon_id";
const CODE_KEY = "cp_access_code";

function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function getAnonId(): string {
  if (typeof window === "undefined") return "";
  try {
    let id = window.localStorage.getItem(STORAGE_KEY);
    if (!id) {
      id = newId();
      window.localStorage.setItem(STORAGE_KEY, id);
    }
    return id;
  } catch {
    // localStorage blocked (e.g. private mode) — fall back to a volatile id.
    return newId();
  }
}

/**
 * Persist a beta access code from the URL (`?code=…`) into localStorage so it
 * survives navigation. Call once on the workspace mount.
 */
export function captureAccessCode(): void {
  if (typeof window === "undefined") return;
  try {
    const code = new URL(window.location.href).searchParams.get("code");
    if (code && code.trim()) {
      window.localStorage.setItem(CODE_KEY, code.trim());
    }
  } catch {
    // ignore
  }
}

function getAccessCode(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(CODE_KEY) ?? "";
  } catch {
    return "";
  }
}

/** Store a beta access code entered manually (via the on-page input). */
export function setAccessCode(code: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CODE_KEY, code.trim());
  } catch {
    // ignore
  }
}

/** Headers to attach to API requests (JSON body by default). */
export function apiHeaders(json = true): Record<string, string> {
  const headers: Record<string, string> = { [ANON_HEADER]: getAnonId() };
  const code = getAccessCode();
  if (code) headers[ACCESS_HEADER] = code;
  if (json) headers["Content-Type"] = "application/json";
  return headers;
}
