import { ensureToken } from "./token";

/**
 * Which identity a request travels under.
 *
 * The extension has two, and they behave differently on failure — which is
 * the whole reason this type exists rather than a bare string. A device token
 * is ours: it expires, we mint another, the user never knows. A Clerk token
 * is the user's session: when it goes, nothing can be minted in its place and
 * the user has to be told.
 */
export type AuthToken =
  | { kind: "clerk"; token: string }
  | { kind: "device"; token: string };

/** Returns the current Clerk session token, or null when signed out. */
export type ClerkTokenSource = () => Promise<string | null>;

/**
 * Injected rather than imported so this module — and the 401 fork that
 * depends on it — is testable without Clerk, and so the panel does not pull
 * Clerk's bundle in just by importing the API client. `lib/clerk.ts` installs
 * the real source; until it does, every caller is a device caller.
 */
let clerkTokenSource: ClerkTokenSource = async () => null;

export function setClerkTokenSource(source: ClerkTokenSource): void {
  clerkTokenSource = source;
}

export async function currentAuthToken(): Promise<AuthToken | null> {
  let clerk: string | null = null;
  try {
    clerk = await clerkTokenSource();
  } catch {
    // Clerk unreachable. Fall through to the device identity rather than
    // failing the request outright — the 401 fork downstream is what keeps a
    // signed-in user from being silently downgraded without being told.
    clerk = null;
  }
  if (clerk) return { kind: "clerk", token: clerk };

  const device = await ensureToken();
  return device ? { kind: "device", token: device } : null;
}
