import { describe, it, expect, beforeEach } from "vitest";
import { getKV, resetKV } from "@/lib/kv";

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

  it("stores and deletes hash fields", async () => {
    const kv = getKV();
    await kv.hset("h", "f", "v");
    expect(await kv.hgetall("h")).toEqual({ f: "v" });
    await kv.hdel("h", "f");
    expect(await kv.hgetall("h")).toEqual({});
  });
});
