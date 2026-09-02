import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { decodeJwt, SignJWT } from "jose";
import {
  issueDeviceToken,
  verifyDeviceToken,
  issueRunToken,
  verifyBearer,
  resolveCaller,
  callerKey,
} from "@/lib/auth";

function req(headers: Record<string, string>): Request {
  return new Request("https://example.com/api/tailor", { headers });
}

// Vitest reuses worker processes across files, so an env var set here would
// otherwise leak into whichever file runs next in the same worker.
afterEach(() => {
  delete process.env.DEVICE_TOKEN_SECRET;
});

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

  // The plan pins this TTL as an exact value, so assert it rather than
  // trusting the constant. Without this, changing "24h" to "240h" keeps the
  // suite green.
  it("issues a token that expires in exactly 24 hours", async () => {
    const { token } = await issueDeviceToken();
    const { iat, exp } = decodeJwt(token);
    expect(exp! - iat!).toBe(24 * 60 * 60);
  });

  // The most security-relevant invariant in this module: an absent secret
  // must fail loudly, never fall back to a guessable default. Every other
  // test sets the secret in beforeEach, so nothing else would catch a
  // `?? "dev-secret"` creeping into secret().
  it("refuses to sign without a secret", async () => {
    delete process.env.DEVICE_TOKEN_SECRET;
    await expect(issueDeviceToken()).rejects.toThrow(/DEVICE_TOKEN_SECRET/);
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

  it("rejects a structurally invalid token even without an anon header", async () => {
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

  // A header that is present but unusable is the extension misbehaving, not a
  // web visitor. It must get the 401 signal, not anon quota.
  it("rejects a non-Bearer scheme rather than degrading to anon", async () => {
    const r = await resolveCaller(
      req({ authorization: "Basic abc", "x-anon-id": "legacy-web-id" }),
      null,
    );
    expect(r).toEqual({ ok: false, reason: "invalid_token" });
  });

  it("rejects a Bearer scheme with an empty token", async () => {
    const r = await resolveCaller(req({ authorization: "Bearer" }), null);
    expect(r).toEqual({ ok: false, reason: "invalid_token" });
  });

  it("accepts a lowercase bearer scheme without corrupting the token", async () => {
    const { token, deviceId } = await issueDeviceToken();
    const r = await resolveCaller(req({ authorization: `bearer ${token}` }), null);
    expect(r).toEqual({ ok: true, caller: { kind: "device", deviceId } });
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

describe("run tokens", () => {
  beforeEach(() => {
    process.env.DEVICE_TOKEN_SECRET = "test-secret-value-at-least-32-chars-long";
  });

  it("round-trips a user id", async () => {
    const token = await issueRunToken("user_abc123");
    expect(await verifyBearer(token)).toEqual({ kind: "user", userId: "user_abc123" });
  });

  it("rejects a tampered token", async () => {
    const token = await issueRunToken("user_abc123");
    const tampered = `${token.slice(0, -4)}AAAA`;
    expect(await verifyBearer(tampered)).toBeNull();
  });

  it("rejects an expired token", async () => {
    // Signed with the same secret and algorithm, but already past its
    // expiry — the one property a short TTL is bought for.
    const past = Math.floor(Date.now() / 1000) - 60;
    const expired = await new SignJWT({ uid: "user_abc123" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(past - 60)
      .setExpirationTime(past)
      .sign(new TextEncoder().encode(process.env.DEVICE_TOKEN_SECRET!));
    expect(await verifyBearer(expired)).toBeNull();
  });

  // THE COLLISION TEST. Both token kinds are signed with the SAME secret and
  // the SAME algorithm, so jwtVerify succeeds for either — only the claim
  // tells them apart. If that discrimination is ever lost, a device token
  // would be honoured as a user and every anonymous caller would spend some
  // real account's daily quota.
  it("does not mistake a device token for a run token", async () => {
    const { token } = await issueDeviceToken();
    const identity = await verifyBearer(token);
    expect(identity?.kind).toBe("device");
  });

  it("does not mistake a run token for a device token", async () => {
    const token = await issueRunToken("user_abc123");
    expect(await verifyDeviceToken(token)).toBeNull();
  });
});

describe("resolveCaller with a run token", () => {
  beforeEach(() => {
    process.env.DEVICE_TOKEN_SECRET = "test-secret-value-at-least-32-chars-long";
  });

  const req = (token: string) =>
    new Request("https://example.com/api/analyze", {
      headers: { Authorization: `Bearer ${token}` },
    });

  it("resolves a run token to the user it was minted for", async () => {
    const token = await issueRunToken("user_abc123");
    const result = await resolveCaller(req(token), null);
    expect(result).toEqual({ ok: true, caller: { kind: "user", userId: "user_abc123" } });
  });

  // The existing rule, restated because this task adds a second way for the
  // bearer branch to succeed: a bearer that is present but invalid is a 401,
  // NEVER a silent downgrade to anon. That refusal is the extension's only
  // way to learn its token died.
  it("still refuses an invalid bearer rather than falling back to anon", async () => {
    const result = await resolveCaller(req("not-a-token"), null);
    expect(result).toEqual({ ok: false, reason: "invalid_token" });
  });
});
