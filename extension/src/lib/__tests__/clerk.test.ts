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
 * Real chrome.storage.local, faked — NOT a mock of `@/lib/storage`. The
 * has-signed-in flag is the thing under test in half the cases below, and
 * mocking the module that owns it would leave the actual key, the actual
 * default-to-false-on-error path, and the actual write untested while the
 * assertions still passed.
 */
function fakeChromeStorage() {
  const data: Record<string, unknown> = {};
  return {
    runtime: { getURL: (path: string) => `chrome-extension://test-id/${path}` },
    storage: {
      local: {
        get: vi.fn(async (keys: string[]) => {
          const out: Record<string, unknown> = {};
          for (const k of keys) if (k in data) out[k] = data[k];
          return out;
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(data, items);
        }),
        remove: vi.fn(async (keys: string[]) => {
          for (const k of keys) delete data[k];
        }),
      },
    },
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
async function installedSourceFn(): Promise<() => Promise<ClerkAuthState>> {
  const session = await import("@/lib/session");
  const setSourceSpy = vi.spyOn(session, "setClerkTokenSource");
  const { installClerkTokenSource } = await import("@/lib/clerk");
  installClerkTokenSource();
  const source = setSourceSpy.mock.calls.at(-1)?.[0];
  if (!source) throw new Error("installClerkTokenSource did not call setClerkTokenSource");
  return source;
}

/**
 * The source function, CALLED. Split from `installedSourceFn` above so the
 * two "Clerk is unreachable" cases can assert on the call itself — one that
 * it resolves, one that it rejects — rather than only on a resolved value.
 */
async function installedSource(): Promise<ClerkAuthState> {
  return (await installedSourceFn())();
}

describe("installClerkTokenSource", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("chrome", fakeChromeStorage());
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

  // FINAL-REVIEW CRITICAL, and the reason the has-signed-in flag exists at
  // all. This source runs on EVERY request from EVERY user, and it used to
  // `await getClerk()` unguarded — a live call to Clerk's Frontend API. A
  // Clerk incident, a paused dev instance, or a corporate proxy blocking
  // *.clerk.accounts.dev made it throw; session.ts (correctly, for a
  // signed-in user) turned that into `session_unavailable`; api.ts then
  // refused the request with no fetch at all. For the entire pre-existing
  // ANONYMOUS user base — people who have never signed in and have no
  // session to protect — that meant the extension simply stopped working
  // whenever Clerk was unreachable, gating anonymous use on Clerk's
  // availability. The plan's binding constraint is the opposite: anonymous
  // use keeps working exactly as before, and sign-in is an upgrade, never a
  // gate. If this guard is ever "simplified" away, this is the assertion
  // that catches it.
  it("falls through to the device identity when Clerk is unreachable and this browser has never signed in", async () => {
    fakeClient = makeFakeClient({
      load: vi.fn(async () => {
        throw new Error("clerk frontend api unreachable");
      }),
    });
    // No cp_has_signed_in in storage — a genuinely anonymous browser.
    await expect(installedSource()).resolves.toEqual({ signedIn: false });
  });

  // The other half of the same asymmetry, and the reason it is a flag rather
  // than a blanket catch: for a browser that HAS signed in, an unreachable
  // Clerk must still refuse the request. We cannot tell whether that user's
  // session is still valid, and answering `{ signedIn: false }` would spend
  // their device trial against the 3-per-30-days bucket while the panel went
  // on showing their email and daily allowance — the silent downgrade this
  // whole module is shaped around.
  it("still rethrows when Clerk is unreachable and this browser HAS signed in before", async () => {
    const { setHasSignedIn } = await import("@/lib/storage");
    await setHasSignedIn();

    fakeClient = makeFakeClient({
      load: vi.fn(async () => {
        throw new Error("clerk frontend api unreachable");
      }),
    });
    await expect(installedSource()).rejects.toThrow("clerk frontend api unreachable");
  });

  // The flag has to be SET somewhere or the guard above never protects
  // anyone. The source itself sets it (covered implicitly by the signed-in
  // cases), and so does this call — the panel's mount/visibilitychange
  // re-check, which is the earliest moment a fresh sign-in becomes visible
  // to the extension.
  it("records that this browser has signed in when Clerk reports a session", async () => {
    const { getHasSignedIn } = await import("@/lib/storage");
    expect(await getHasSignedIn()).toBe(false);

    fakeClient = makeFakeClient({
      isSignedIn: true,
      session: { getToken: vi.fn(async () => "the-token") },
    });
    const { isSignedIn } = await import("@/lib/clerk");
    expect(await isSignedIn()).toBe(true);

    expect(await getHasSignedIn()).toBe(true);
  });

  it("does not record a signed-in browser when Clerk reports no session", async () => {
    const { getHasSignedIn } = await import("@/lib/storage");
    fakeClient = makeFakeClient({ isSignedIn: false });
    const { isSignedIn } = await import("@/lib/clerk");
    expect(await isSignedIn()).toBe(false);
    expect(await getHasSignedIn()).toBe(false);
  });
});
