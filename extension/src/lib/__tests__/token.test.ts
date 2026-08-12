import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { ensureToken } from "@/lib/token";
import { getToken, setToken } from "@/lib/storage";

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
        set: vi.fn(async (items: Record<string, unknown>) => Object.assign(data, items)),
        remove: vi.fn(async (keys: string[]) => keys.forEach((k) => delete data[k])),
      },
    },
  };
}

describe("ensureToken", () => {
  beforeEach(() => {
    vi.stubGlobal("chrome", fakeChromeStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("mints a token when none is stored", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ token: "fresh" }), { status: 200 })),
    );
    expect(await ensureToken()).toBe("fresh");
    expect(await getToken()).toBe("fresh");
  });

  it("reuses a stored token without calling the network", async () => {
    await setToken("cached");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await ensureToken()).toBe("cached");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("re-mints when forced, even with a token stored", async () => {
    await setToken("stale");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ token: "renewed" }), { status: 200 })),
    );
    expect(await ensureToken(true)).toBe("renewed");
    expect(await getToken()).toBe("renewed");
  });

  it("returns null and stores nothing when the server cannot issue one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "nope" }), { status: 503 })),
    );
    expect(await ensureToken()).toBeNull();
    expect(await getToken()).toBeNull();
  });

  it("returns null when the network throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await ensureToken()).toBeNull();
  });

  it("dedupes concurrent forced refreshes into a single mint", async () => {
    // run.ts fires /api/analyze and /api/tailor in parallel; if a shared
    // token is rejected mid-run, both legs call ensureToken(true) around the
    // same tick. Without in-flight dedup, that mints two device identities
    // server-side and the two legs land in different quota buckets.
    await setToken("stale");
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ token: "renewed" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const [a, b] = await Promise.all([ensureToken(true), ensureToken(true)]);

    expect(a).toBe("renewed");
    expect(b).toBe("renewed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await getToken()).toBe("renewed");
  });

  it("allows a fresh mint after the in-flight one settles", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: "first" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: "second" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await ensureToken(true)).toBe("first");
    expect(await ensureToken(true)).toBe("second");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
