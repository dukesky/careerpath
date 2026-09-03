import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getKV, resetKV, isRedisConfigured } from "@/lib/kv";

// getKV() warns once per process when it falls back to the in-memory store.
// That warning is deliberate and load-bearing in production; here it would be
// noise, so silence it and let the assertions below cover the logic instead.
vi.spyOn(console, "warn").mockImplementation(() => {});

describe("in-memory KV store", () => {
  beforeEach(() => {
    resetKV();
  });

  it("counts up from zero", async () => {
    const kv = getKV();
    expect(await kv.getCount("a")).toBe(0);
    expect(await kv.incr("a", 60)).toBe(1);
    expect(await kv.incr("a", 60)).toBe(2);
    expect(await kv.getCount("a")).toBe(2);
  });

  it("isolates state between tests via resetKV", async () => {
    expect(await getKV().getCount("a")).toBe(0);
  });

  // The failure this exists for was found by the evaluator, not by a unit
  // test: /api/rescore 403'd on a run marker /api/analyze had genuinely
  // written, because `next dev` bundles each route separately and each bundle
  // got its OWN module instance — and, before this, its own Map. Nothing
  // looked broken from inside any single route; the counter simply never
  // moved. `vi.resetModules()` reproduces exactly that: a second instance of
  // this module, in the same process, whose module-level `store` is null.
  it("shares one store across module instances in the same process", async () => {
    await getKV().incr("shared-key", 60);

    vi.resetModules();
    const fresh = await import("@/lib/kv");

    expect(await fresh.getKV().getCount("shared-key")).toBe(1);
  });

  it("stores and deletes hash fields", async () => {
    const kv = getKV();
    await kv.hset("h", "f", "v");
    expect(await kv.hgetall("h")).toEqual({ f: "v" });
    await kv.hdel("h", "f");
    expect(await kv.hgetall("h")).toEqual({});
  });
});

describe("redis credential resolution", () => {
  const REDIS_VARS = [
    "UPSTASH_REDIS_REST_URL",
    "UPSTASH_REDIS_REST_TOKEN",
    "KV_REST_API_URL",
    "KV_REST_API_TOKEN",
  ];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of REDIS_VARS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    resetKV();
  });

  afterEach(() => {
    for (const k of REDIS_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetKV();
  });

  // This is the check that already existed and was never called from anywhere,
  // which is how four release cycles shipped against the in-memory store.
  it("reports unconfigured when neither name pair is set", () => {
    expect(isRedisConfigured()).toBe(false);
  });

  it("accepts the Upstash-native names", () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "t";
    expect(isRedisConfigured()).toBe(true);
  });

  // Vercel's Marketplace integration writes THESE names, not the Upstash ones.
  // Provisioning through Vercel must therefore need no code change at all — if
  // this pair stops being accepted, production silently drops back to the
  // in-memory store while every test still passes.
  it("accepts the Vercel Marketplace names", () => {
    process.env.KV_REST_API_URL = "https://example.upstash.io";
    process.env.KV_REST_API_TOKEN = "t";
    expect(isRedisConfigured()).toBe(true);
  });

  it("rejects a url with no token, rather than half-configuring", () => {
    process.env.KV_REST_API_URL = "https://example.upstash.io";
    expect(isRedisConfigured()).toBe(false);
  });
});
