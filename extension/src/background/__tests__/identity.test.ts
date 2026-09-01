import { describe, it, expect, beforeEach, vi } from "vitest";

let createCalls: Array<{ publishableKey: string }> = [];
let createImpl: () => Promise<unknown> = async () => ({ isSignedIn: false, session: null });

// The /background subpath, NOT /client. Its createClerkClient forces
// `background: true`, which is what yields a headless client that works
// without a DOM and loads itself. Mocking the wrong path here would let a
// wrong import in the module under test pass unnoticed.
vi.mock("@clerk/chrome-extension/background", () => ({
  createClerkClient: (opts: { publishableKey: string }) => {
    createCalls.push(opts);
    return createImpl();
  },
}));

let storageListener: ((changes: Record<string, unknown>, area: string) => void) | undefined;

beforeEach(() => {
  createCalls = [];
  createImpl = async () => ({ isSignedIn: false, session: null });
  storageListener = undefined;
  vi.resetModules();

  const data: Record<string, unknown> = {};
  vi.stubGlobal("chrome", {
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
      onChanged: {
        addListener: vi.fn((cb) => {
          storageListener = cb;
        }),
      },
    },
  });
});

/** Installs the source and hands back the function it registered. */
async function installedSource() {
  const session = await import("@/lib/session");
  const spy = vi.spyOn(session, "setClerkTokenSource");
  const { installBackgroundClerkTokenSource } = await import("../identity");
  installBackgroundClerkTokenSource();
  const source = spy.mock.calls.at(-1)?.[0];
  if (!source) throw new Error("installBackgroundClerkTokenSource did not set a source");
  return source;
}

describe("installBackgroundClerkTokenSource", () => {
  it("installs a source that reports the signed-in user's token", async () => {
    createImpl = async () => ({
      isSignedIn: true,
      session: { getToken: async () => "worker-token" },
    });
    const source = await installedSource();
    expect(await source()).toEqual({ signedIn: true, token: "worker-token" });
  });

  it("passes the publishable key and never calls load() itself", async () => {
    const load = vi.fn();
    createImpl = async () => ({ isSignedIn: false, session: null, load });
    const source = await installedSource();
    await source();

    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].publishableKey).toBeTruthy();
    // createClerkClient({background:true}) already calls
    // load({standardBrowser:false}) internally. A second load() here would be
    // a duplicate round trip against Clerk's Frontend API on every cold start.
    expect(load).not.toHaveBeenCalled();
  });

  it("creates the client once and reuses it across requests", async () => {
    createImpl = async () => ({
      isSignedIn: true,
      session: { getToken: async () => "t" },
    });
    const source = await installedSource();
    await source();
    await source();
    expect(createCalls).toHaveLength(1);
  });

  // A transient Clerk outage at worker cold start must not poison every later
  // request for the rest of that worker's life. The panel's client has the
  // same reset for the same reason — see lib/clerk.ts's `load()`.
  it("does not cache a failure forever", async () => {
    const { setHasSignedIn } = await import("@/lib/storage");
    await setHasSignedIn();

    createImpl = async () => {
      throw new Error("clerk unreachable");
    };
    const source = await installedSource();
    await expect(source()).rejects.toThrow("clerk unreachable");

    createImpl = async () => ({
      isSignedIn: true,
      session: { getToken: async () => "recovered" },
    });
    expect(await source()).toEqual({ signedIn: true, token: "recovered" });
  });

  // Sign-out happens in the PANEL. The worker's cached client would go on
  // reporting a signed-in user until the worker died, so a run started after
  // sign-out would transact as someone who is no longer signed in.
  it("drops the cached client when Clerk's stored JWT changes", async () => {
    createImpl = async () => ({
      isSignedIn: true,
      session: { getToken: async () => "first" },
    });
    const source = await installedSource();
    await source();
    expect(createCalls).toHaveLength(1);

    createImpl = async () => ({
      isSignedIn: true,
      session: { getToken: async () => "second" },
    });
    storageListener?.({ "clerk.career-allpath.com|__clerk_client_jwt|v2": {} }, "local");

    expect(await source()).toEqual({ signedIn: true, token: "second" });
    expect(createCalls).toHaveLength(2);
  });

  // The listener above can fire while a create() is still in flight — a
  // sign-out can land mid-request, not just between requests. If a create's
  // own .catch cleared `clerkPromise` unconditionally, a LATE rejection from
  // a stale, already-superseded create could wipe out a newer, valid,
  // already-resolved client — costing the next caller a needless extra
  // create even though nothing was wrong with the cache. This pins the fix:
  // a create only clears the slot it still owns.
  it("does not let a late-rejecting stale create clobber a newer valid client", async () => {
    let rejectFirst: ((err: Error) => void) | undefined;
    let createCount = 0;

    createImpl = () => {
      createCount += 1;
      if (createCount === 1) {
        // Held open deliberately — this create is still in flight when the
        // storage listener fires below.
        return new Promise((_resolve, reject) => {
          rejectFirst = reject;
        });
      }
      return Promise.resolve({
        isSignedIn: true,
        session: { getToken: async () => "second" },
      });
    };

    const source = await installedSource();

    // Call A starts the first create and is left pending.
    const callA = source();

    // Sign-out lands while call A's create is still in flight: the listener
    // clears the cache slot out from under it.
    storageListener?.({ "clerk.career-allpath.com|__clerk_client_jwt|v2": {} }, "local");

    // Call B sees an empty slot and creates + caches a second, good client.
    expect(await source()).toEqual({ signedIn: true, token: "second" });
    expect(createCalls).toHaveLength(2);

    // Call A's stale create finally rejects. Its own .catch must see that
    // the slot no longer belongs to it and leave call B's client cached.
    rejectFirst?.(new Error("stale create failed"));
    // Consumed here (not asserted on) so the rejection is handled either
    // way — makeClerkTokenSource may or may not rethrow it depending on the
    // has-signed-in flag, and that choice is not what this test is about.
    await callA.catch(() => {});

    // A third call must reuse call B's cached client, not create a third
    // one.
    expect(await source()).toEqual({ signedIn: true, token: "second" });
    expect(createCalls).toHaveLength(2);
  });

  it("ignores unrelated storage changes", async () => {
    createImpl = async () => ({
      isSignedIn: true,
      session: { getToken: async () => "t" },
    });
    const source = await installedSource();
    await source();
    storageListener?.({ cp_results: {} }, "local");
    await source();
    expect(createCalls).toHaveLength(1);
  });
});
