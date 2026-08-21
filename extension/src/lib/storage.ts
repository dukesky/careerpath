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
/**
 * "Has this browser ever completed a Clerk sign-in?" — a hint, not an
 * identity. It carries no token and proves nothing to the server; the only
 * thing that reads it is lib/clerk.ts's token source, to decide what to do
 * when Clerk itself is UNREACHABLE. Signed in before: refuse the request, so
 * a signed-in user is never silently downgraded to the device tier. Never
 * signed in: fall through to the device identity, which is exactly what an
 * anonymous user did before sign-in existed. Without this distinction, every
 * anonymous user's requests would be blocked whenever Clerk had an incident
 * or a proxy blocked its domain — gating anonymous use on Clerk being
 * reachable, which the design forbids.
 */
const HAS_SIGNED_IN_KEY = "cp_has_signed_in";

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

/**
 * Defaults to `false` on ANY failure, deliberately. The consequence of a
 * wrong `false` is that an unreachable Clerk lets a request through on the
 * device identity; the consequence of a wrong `true` is that a user who has
 * never signed in cannot use the extension at all while Clerk is down. Only
 * one of those two is a regression against the anonymous behaviour that
 * predates sign-in, so an unreadable flag reads as "never signed in".
 */
export async function getHasSignedIn(): Promise<boolean> {
  try {
    const got = await chrome.storage.local.get([HAS_SIGNED_IN_KEY]);
    return got[HAS_SIGNED_IN_KEY] === true;
  } catch {
    return false;
  }
}

/**
 * Swallows its own failure rather than throwing. This is called from the
 * middle of the sign-in path (lib/clerk.ts's `isSignedIn` and its token
 * source), and a storage write failing there must not break the sign-in that
 * has otherwise just succeeded — the flag is an optimisation for a Clerk
 * outage, not a precondition for being signed in. Logged, not silent, so the
 * degraded state is at least visible in the panel's console.
 */
export async function setHasSignedIn(): Promise<void> {
  try {
    await chrome.storage.local.set({ [HAS_SIGNED_IN_KEY]: true });
  } catch (err) {
    console.warn(
      JSON.stringify({
        evt: "set_has_signed_in_failed",
        message: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

export async function clearHasSignedIn(): Promise<void> {
  await chrome.storage.local.remove([HAS_SIGNED_IN_KEY]);
}
