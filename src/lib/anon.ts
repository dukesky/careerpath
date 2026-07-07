// Client-side anonymous id: generated once, persisted in localStorage, and
// sent with API requests so the server can attribute anonymous quota.
export const ANON_HEADER = "x-anon-id";

const STORAGE_KEY = "cp_anon_id";

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

/** Headers to attach to API requests (JSON body by default). */
export function apiHeaders(json = true): Record<string, string> {
  const headers: Record<string, string> = { [ANON_HEADER]: getAnonId() };
  if (json) headers["Content-Type"] = "application/json";
  return headers;
}
