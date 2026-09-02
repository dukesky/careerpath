import { describe, it, expect, vi, beforeEach } from "vitest";

let postResult: unknown = { ok: true, data: { token: "run-token-xyz" } };
let signedIn = true;

vi.mock("@/lib/api", () => ({ apiPost: async () => postResult }));
vi.mock("@/lib/clerk", () => ({ isSignedIn: async () => signedIn }));

beforeEach(() => {
  vi.resetModules();
  postResult = { ok: true, data: { token: "run-token-xyz" } };
  signedIn = true;
});

describe("fetchRunToken", () => {
  it("returns the token for a signed-in user", async () => {
    const { fetchRunToken } = await import("@/lib/runToken");
    expect(await fetchRunToken()).toEqual({ ok: true, token: "run-token-xyz" });
  });

  // Anonymous callers get null, NOT a failure. The run still starts, on the
  // device identity — signing in is an upgrade, never a gate.
  it("returns null when the user is not signed in", async () => {
    signedIn = false;
    const { fetchRunToken } = await import("@/lib/runToken");
    expect(await fetchRunToken()).toBeNull();
  });

  // Signed in but the mint failed. This must NOT collapse into the anonymous
  // case: doing so would spend the user's device trial while the panel showed
  // them their daily allowance.
  it("reports the failure when a signed-in user cannot get a token", async () => {
    postResult = { ok: false, kind: "session_expired", message: "Sign in again." };
    const { fetchRunToken } = await import("@/lib/runToken");
    const result = await fetchRunToken();
    expect(result).toEqual({
      ok: false,
      kind: "session_expired",
      message: "Sign in again.",
    });
  });

  it("reports a malformed response rather than returning an empty token", async () => {
    postResult = { ok: true, data: {} };
    const { fetchRunToken } = await import("@/lib/runToken");
    const result = await fetchRunToken();
    expect(result).toMatchObject({ ok: false });
  });
});
