import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { getKV, resetKV } from "@/lib/kv";
import { recordLLMCall, withStats } from "@/lib/llm-stats";

describe("recordLLMCall", () => {
  beforeEach(() => {
    resetKV();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("increments the per-task/model counters", async () => {
    await recordLLMCall({
      task: "analyze",
      model: "m1",
      durationMs: 1200,
      promptTokens: 100,
      completionTokens: 50,
      ok: true,
    });
    const kv = getKV();
    const keys = await kv.hgetall("stats:analyze:m1");
    expect(Number(keys.calls)).toBe(1);
    expect(Number(keys.totalMs)).toBe(1200);
    expect(Number(keys.promptTokens)).toBe(100);
    expect(Number(keys.completionTokens)).toBe(50);
    expect(Number(keys.failures)).toBe(0);
  });

  it("accumulates across calls and counts failures separately", async () => {
    const base = { task: "tailor", model: "m2", promptTokens: 10, completionTokens: 5 };
    await recordLLMCall({ ...base, durationMs: 100, ok: true });
    await recordLLMCall({ ...base, durationMs: 300, ok: false });
    const keys = await getKV().hgetall("stats:tailor:m2");
    expect(Number(keys.calls)).toBe(2);
    expect(Number(keys.totalMs)).toBe(400);
    expect(Number(keys.failures)).toBe(1);
  });

  it("emits one structured log line per call", async () => {
    const spy = vi.spyOn(console, "log");
    await recordLLMCall({
      task: "parse",
      model: "m3",
      durationMs: 42,
      promptTokens: 1,
      completionTokens: 2,
      ok: true,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(spy.mock.calls[0][0] as string);
    expect(payload).toMatchObject({ evt: "llm_call", task: "parse", model: "m3", ok: true });
  });

  it("never throws when the store fails", async () => {
    vi.spyOn(getKV(), "hset").mockRejectedValue(new Error("redis down"));
    await expect(
      recordLLMCall({
        task: "parse",
        model: "m4",
        durationMs: 1,
        promptTokens: 0,
        completionTokens: 0,
        ok: true,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("withStats", () => {
  beforeEach(() => {
    resetKV();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the inner result and records a successful call", async () => {
    const out = await withStats({ task: "analyze", model: "m5" }, async () => ({
      result: "hello",
      promptTokens: 7,
      completionTokens: 3,
    }));
    expect(out).toBe("hello");
    const keys = await getKV().hgetall("stats:analyze:m5");
    expect(Number(keys.calls)).toBe(1);
    expect(Number(keys.failures)).toBe(0);
  });

  it("records a failure and rethrows", async () => {
    await expect(
      withStats({ task: "analyze", model: "m6" }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const keys = await getKV().hgetall("stats:analyze:m6");
    expect(Number(keys.calls)).toBe(1);
    expect(Number(keys.failures)).toBe(1);
  });
});
