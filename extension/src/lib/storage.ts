import type { ParsedResume } from "@shared/contract";

/**
 * The base resume and the device token, in chrome.storage.local — on the
 * user's device, never uploaded for storage. The /privacy page commits to
 * this in writing; do not add a sync-storage or server-side mirror.
 *
 * Generated results are also persisted, in lib/cache.ts. Both are covered by
 * the same promise, and both must stay local.
 */

const RESUME_KEY = "cp_resume";
const TOKEN_KEY = "cp_device_token";

export interface StoredResume {
  resume: ParsedResume;
  /** ISO 8601, shown in the panel's "My resume" block. */
  parsedAt: string;
  /** Display name pulled off the parsed contact block, for the same block. */
  name: string;
}

async function readJson<T>(key: string): Promise<T | null> {
  try {
    const got = await chrome.storage.local.get([key]);
    const raw = got[key];
    if (typeof raw !== "string") return null;
    return JSON.parse(raw) as T;
  } catch {
    // Corrupt or unreadable — treat as absent rather than breaking the panel.
    return null;
  }
}

export async function getResume(): Promise<StoredResume | null> {
  return readJson<StoredResume>(RESUME_KEY);
}

export async function setResume(value: StoredResume): Promise<void> {
  await chrome.storage.local.set({ [RESUME_KEY]: JSON.stringify(value) });
}

export async function clearResume(): Promise<void> {
  await chrome.storage.local.remove([RESUME_KEY]);
}

export async function getToken(): Promise<string | null> {
  try {
    const got = await chrome.storage.local.get([TOKEN_KEY]);
    const raw = got[TOKEN_KEY];
    return typeof raw === "string" && raw ? raw : null;
  } catch {
    return null;
  }
}

export async function setToken(token: string): Promise<void> {
  await chrome.storage.local.set({ [TOKEN_KEY]: token });
}

export async function clearToken(): Promise<void> {
  await chrome.storage.local.remove([TOKEN_KEY]);
}
