import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ClerkAuthState } from "@/lib/session";

// The exact three-state boundary this test exists to pin: `installClerkTokenSource`
// wires a source function into session.ts, and that function must never
// collapse "signed in, no token" into "signed out" — see clerk.ts's doc
// comment on `installClerkTokenSource` and session.ts's `ClerkAuthState` for
// why. The consumer side (currentAuthToken) is covered by session.test.ts;
// this file covers the producer side, which previously had no test at all.

type FakeSession = { getToken: () => Promise<string | null> };
type FakeUser = { primaryEmailAddress: { emailAddress: string } | null };
type FakeClient = {
  isSignedIn: boolean;
  session: FakeSession | null;
  user: FakeUser | null;
  load: () => Promise<void>;
};

let fakeClient: FakeClient;

vi.mock("@clerk/chrome-extension/client", () => ({
  createClerkClient: vi.fn(() => fakeClient),
}));

function makeFakeClient(overrides: Partial<FakeClient> = {}): FakeClient {
  return {
    isSignedIn: false,
    session: null,
    user: null,
    load: vi.fn(async () => {}),
    ...overrides,
  };
}

/**
 * `clerk.ts` memoizes its loaded client at module scope (deliberately — see
 * clerk.ts's fix report on caching a rejection forever). That memoization
 * would leak the FIRST test's `fakeClient` into every later test unless each
 * test gets a genuinely fresh `@/lib/clerk` module. `vi.resetModules()`
 * clears the registry; importing BOTH `@/lib/session` and `@/lib/clerk`
 * dynamically, inside this function, after that reset, is what keeps them
 * resolving to the SAME fresh instances — a stale top-level
 * `import * as sessionLib` would spy on a session.ts instance that the
 * freshly re-imported clerk.ts is no longer talking to.
 */
async function installedSource(): Promise<ClerkAuthState> {
  const session = await import("@/lib/session");
  const setSourceSpy = vi.spyOn(session, "setClerkTokenSource");
  const { installClerkTokenSource } = await import("@/lib/clerk");
  installClerkTokenSource();
  const source = setSourceSpy.mock.calls.at(-1)?.[0];
  if (!source) throw new Error("installClerkTokenSource did not call setClerkTokenSource");
  return source();
}

describe("installClerkTokenSource", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("chrome", {
      runtime: { getURL: (path: string) => `chrome-extension://test-id/${path}` },
    });
  });

  it("reports signed out when Clerk says the user is not signed in", async () => {
    fakeClient = makeFakeClient({ isSignedIn: false });
    expect(await installedSource()).toEqual({ signedIn: false });
  });

  it("reports the token when signed in with a session", async () => {
    fakeClient = makeFakeClient({
      isSignedIn: true,
      session: { getToken: vi.fn(async () => "the-token") },
    });
    expect(await installedSource()).toEqual({ signedIn: true, token: "the-token" });
  });

  // The state that matters most: collapsing this into `{ signedIn: false }`
  // is the exact bug session.ts's ClerkAuthState type exists to prevent (see
  // its doc comment) — a signed-in user would silently fall back to the
  // device identity and spend a trial they could not see. If someone
  // "simplifies" installClerkTokenSource back to a bare `?? null` fallback,
  // this is the assertion that catches it.
  it("reports signed in with a null token when Clerk has no session to give", async () => {
    fakeClient = makeFakeClient({ isSignedIn: true, session: null });
    expect(await installedSource()).toEqual({ signedIn: true, token: null });
  });

  it("reports signed in with a null token when getToken() itself resolves null", async () => {
    fakeClient = makeFakeClient({
      isSignedIn: true,
      session: { getToken: vi.fn(async () => null) },
    });
    expect(await installedSource()).toEqual({ signedIn: true, token: null });
  });
});
