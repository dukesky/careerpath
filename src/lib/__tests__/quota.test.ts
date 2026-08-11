import { describe, it, expect, beforeEach } from "vitest";
import { resetKV } from "@/lib/kv";
import {
  getQuota,
  consumeRun,
  DAILY_USER_LIMIT,
  DEVICE_TRIAL_LIMIT,
  LEGACY_ANON_LIMIT,
  DAILY_IP_LIMIT,
} from "@/lib/quota";
import type { Caller } from "@/lib/auth";

const user: Caller = { kind: "user", userId: "u1" };
const device: Caller = { kind: "device", deviceId: "d1" };
const anon: Caller = { kind: "anon", anonId: "a1" };
const IP = "1.2.3.4";

let run = 0;
const nextRun = () => `run-${run++}`;

describe("quota tiers", () => {
  beforeEach(() => {
    resetKV();
    run = 0;
  });

  it("gives a signed-in user the daily allowance", async () => {
    const q = await getQuota(user, IP);
    expect(q.limit).toBe(DAILY_USER_LIMIT);
    expect(q.remaining).toBe(DAILY_USER_LIMIT);
    expect(q.exhausted).toBe(false);
  });

  it("exhausts a signed-in user after the daily allowance", async () => {
    for (let i = 0; i < DAILY_USER_LIMIT; i++) {
      await consumeRun(user, IP, nextRun());
    }
    const q = await getQuota(user, IP);
    expect(q.used).toBe(DAILY_USER_LIMIT);
    expect(q.remaining).toBe(0);
    expect(q.exhausted).toBe(true);
  });

  it("gives an extension device the smaller trial allowance", async () => {
    expect((await getQuota(device, IP)).limit).toBe(DEVICE_TRIAL_LIMIT);
    for (let i = 0; i < DEVICE_TRIAL_LIMIT; i++) {
      await consumeRun(device, IP, nextRun());
    }
    expect((await getQuota(device, IP)).exhausted).toBe(true);
  });

  it("keeps the legacy web anonymous allowance unchanged", async () => {
    expect((await getQuota(anon, IP)).limit).toBe(LEGACY_ANON_LIMIT);
  });

  it("keeps tiers independent of one another", async () => {
    for (let i = 0; i < DEVICE_TRIAL_LIMIT; i++) {
      await consumeRun(device, IP, nextRun());
    }
    expect((await getQuota(device, IP)).exhausted).toBe(true);
    // Signing in grants a fresh daily allowance — no carry-over.
    expect((await getQuota(user, IP)).remaining).toBe(DAILY_USER_LIMIT);
  });

  it("blocks on the IP ceiling even when the tier has room", async () => {
    for (let i = 0; i < DAILY_IP_LIMIT; i++) {
      await consumeRun({ kind: "user", userId: `u${i}` }, IP, nextRun());
    }
    const q = await getQuota({ kind: "user", userId: "fresh" }, IP);
    expect(q.exhausted).toBe(true);
    expect(q.remaining).toBe(0);
  });

  it("does not apply the IP ceiling to an unknown IP", async () => {
    for (let i = 0; i < DAILY_IP_LIMIT + 5; i++) {
      await consumeRun({ kind: "user", userId: `u${i}` }, "unknown", nextRun());
    }
    expect((await getQuota({ kind: "user", userId: "fresh" }, "unknown")).exhausted).toBe(
      false,
    );
  });
});

describe("run idempotency", () => {
  beforeEach(() => {
    resetKV();
    run = 0;
  });

  it("charges one unit for repeated calls with the same runId", async () => {
    await consumeRun(user, IP, "same-run");
    await consumeRun(user, IP, "same-run");
    await consumeRun(user, IP, "same-run");
    expect((await getQuota(user, IP)).used).toBe(1);
  });

  it("charges one unit when analyze and tailor finish in parallel", async () => {
    await Promise.all([
      consumeRun(user, IP, "parallel-run"),
      consumeRun(user, IP, "parallel-run"),
    ]);
    expect((await getQuota(user, IP)).used).toBe(1);
  });

  it("charges separately for distinct runIds", async () => {
    await consumeRun(user, IP, "run-a");
    await consumeRun(user, IP, "run-b");
    expect((await getQuota(user, IP)).used).toBe(2);
  });

  it("scopes the run marker per caller", async () => {
    await consumeRun(user, IP, "shared-id");
    await consumeRun({ kind: "user", userId: "u2" }, IP, "shared-id");
    expect((await getQuota(user, IP)).used).toBe(1);
    expect((await getQuota({ kind: "user", userId: "u2" }, IP)).used).toBe(1);
  });

  it("returns the post-consumption state", async () => {
    const q = await consumeRun(user, IP, nextRun());
    expect(q.used).toBe(1);
    expect(q.remaining).toBe(DAILY_USER_LIMIT - 1);
  });
});
