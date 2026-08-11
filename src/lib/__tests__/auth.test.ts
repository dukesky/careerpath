import { describe, it, expect, beforeEach } from "vitest";
import {
  issueDeviceToken,
  verifyDeviceToken,
  resolveCaller,
  callerKey,
} from "@/lib/auth";

function req(headers: Record<string, string>): Request {
  return new Request("https://example.com/api/tailor", { headers });
}

describe("device tokens", () => {
  beforeEach(() => {
    process.env.DEVICE_TOKEN_SECRET = "test-secret-value-at-least-32-chars-long";
  });

  it("round-trips a signed token back to its device id", async () => {
    const { token, deviceId } = await issueDeviceToken();
    expect(deviceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await verifyDeviceToken(token)).toBe(deviceId);
  });

  it("issues a distinct device id each time", async () => {
    const a = await issueDeviceToken();
    const b = await issueDeviceToken();
    expect(a.deviceId).not.toBe(b.deviceId);
  });

  it("rejects a tampered token", async () => {
    const { token } = await issueDeviceToken();
    const tampered = token.slice(0, -3) + "aaa";
    expect(await verifyDeviceToken(tampered)).toBeNull();
  });

  it("rejects a token signed with a different secret", async () => {
    const { token } = await issueDeviceToken();
    process.env.DEVICE_TOKEN_SECRET = "a-completely-different-secret-value-32ch";
    expect(await verifyDeviceToken(token)).toBeNull();
  });

  it("rejects garbage", async () => {
    expect(await verifyDeviceToken("not-a-jwt")).toBeNull();
    expect(await verifyDeviceToken("")).toBeNull();
  });
});

describe("resolveCaller", () => {
  beforeEach(() => {
    process.env.DEVICE_TOKEN_SECRET = "test-secret-value-at-least-32-chars-long";
  });

  it("prefers a signed-in Clerk user over everything else", async () => {
    const { token } = await issueDeviceToken();
    const r = await resolveCaller(
      req({ authorization: `Bearer ${token}`, "x-anon-id": "abc" }),
      "user_123",
    );
    expect(r).toEqual({ ok: true, caller: { kind: "user", userId: "user_123" } });
  });

  it("falls back to a valid device token", async () => {
    const { token, deviceId } = await issueDeviceToken();
    const r = await resolveCaller(req({ authorization: `Bearer ${token}` }), null);
    expect(r).toEqual({ ok: true, caller: { kind: "device", deviceId } });
  });

  it("falls back to the legacy x-anon-id header when no token is present", async () => {
    const r = await resolveCaller(req({ "x-anon-id": "legacy-web-id" }), null);
    expect(r).toEqual({ ok: true, caller: { kind: "anon", anonId: "legacy-web-id" } });
  });

  it("REJECTS a present-but-invalid bearer token instead of degrading to anon", async () => {
    const r = await resolveCaller(
      req({ authorization: "Bearer garbage", "x-anon-id": "legacy-web-id" }),
      null,
    );
    expect(r).toEqual({ ok: false, reason: "invalid_token" });
  });

  it("rejects an expired-looking token even without an anon header", async () => {
    const r = await resolveCaller(req({ authorization: "Bearer a.b.c" }), null);
    expect(r).toEqual({ ok: false, reason: "invalid_token" });
  });

  it("still prefers a signed-in user even when the bearer token is invalid", async () => {
    const r = await resolveCaller(
      req({ authorization: "Bearer garbage" }),
      "user_123",
    );
    expect(r).toEqual({ ok: true, caller: { kind: "user", userId: "user_123" } });
  });

  it("returns an empty anon caller when nothing identifies the request", async () => {
    expect(await resolveCaller(req({}), null)).toEqual({
      ok: true,
      caller: { kind: "anon", anonId: "" },
    });
  });

  it("caps an absurdly long anon id", async () => {
    const r = await resolveCaller(req({ "x-anon-id": "z".repeat(500) }), null);
    expect(r).toEqual({ ok: true, caller: { kind: "anon", anonId: "z".repeat(100) } });
  });
});

describe("callerKey", () => {
  it("namespaces each caller kind distinctly", () => {
    expect(callerKey({ kind: "user", userId: "u1" })).toBe("user:u1");
    expect(callerKey({ kind: "device", deviceId: "d1" })).toBe("device:d1");
    expect(callerKey({ kind: "anon", anonId: "a1" })).toBe("anon:a1");
    expect(callerKey({ kind: "anon", anonId: "" })).toBe("anon:none");
  });
});
