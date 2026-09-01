import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeClerkTokenSource, type ClerkLike } from "@/lib/clerkTokenSource";

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

function client(overrides: Partial<ClerkLike> = {}): ClerkLike {
  return { isSignedIn: false, session: null, ...overrides };
}

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("chrome", fakeChromeStorage());
});

describe("makeClerkTokenSource", () => {
  it("reports signed out when Clerk says the user is not signed in", async () => {
    const source = makeClerkTokenSource(async () => client({ isSignedIn: false }));
    expect(await source()).toEqual({ signedIn: false });
  });

  it("reports the token when signed in with a session", async () => {
    const source = makeClerkTokenSource(async () =>
      client({ isSignedIn: true, session: { getToken: async () => "the-token" } }),
    );
    expect(await source()).toEqual({ signedIn: true, token: "the-token" });
  });

  // The state that matters most: collapsing this into `{ signedIn: false }`
  // is the exact bug session.ts's ClerkAuthState type exists to prevent — a
  // signed-in user would silently fall back to the device identity and spend
  // a trial they could not see.
  it("reports signed in with a null token when Clerk has no session to give", async () => {
    const source = makeClerkTokenSource(async () => client({ isSignedIn: true, session: null }));
    expect(await source()).toEqual({ signedIn: true, token: null });
  });

  it("reports signed in with a null token when getToken() itself resolves null", async () => {
    const source = makeClerkTokenSource(async () =>
      client({ isSignedIn: true, session: { getToken: async () => null } }),
    );
    expect(await source()).toEqual({ signedIn: true, token: null });
  });

  // The asymmetry this factory exists to hold in ONE place. Anonymous use
  // must keep working while Clerk is down; sign-in is an upgrade, never a
  // gate.
  it("falls through to the device identity when the client fails and this browser has never signed in", async () => {
    const source = makeClerkTokenSource(async () => {
      throw new Error("clerk frontend api unreachable");
    });
    await expect(source()).resolves.toEqual({ signedIn: false });
  });

  // The other half: for a browser that HAS signed in, an unreachable Clerk
  // must still refuse, or we spend their device trial while the panel goes on
  // showing their email and daily allowance.
  it("rethrows when the client fails and this browser HAS signed in before", async () => {
    const { setHasSignedIn } = await import("@/lib/storage");
    await setHasSignedIn();
    const source = makeClerkTokenSource(async () => {
      throw new Error("clerk frontend api unreachable");
    });
    await expect(source()).rejects.toThrow("clerk frontend api unreachable");
  });

  it("records that this browser has signed in whenever Clerk reports a session", async () => {
    const { getHasSignedIn } = await import("@/lib/storage");
    expect(await getHasSignedIn()).toBe(false);
    const source = makeClerkTokenSource(async () =>
      client({ isSignedIn: true, session: { getToken: async () => "t" } }),
    );
    await source();
    expect(await getHasSignedIn()).toBe(true);
  });
});
