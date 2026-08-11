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
});
