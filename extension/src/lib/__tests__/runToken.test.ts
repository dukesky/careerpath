import { describe, it, expect, vi, beforeEach } from "vitest";

let postResult: unknown = { ok: true, data: { token: "run-token-xyz" } };
let postCalls = 0;
let signedInImpl: () => Promise<boolean> = async () => true;
let hasSignedIn = false;

vi.mock("@/lib/api", () => ({
  apiPost: async () => {
    postCalls += 1;
    return postResult;
  },
}));
vi.mock("@/lib/clerk", () => ({ isSignedIn: () => signedInImpl() }));
vi.mock("@/lib/storage", () => ({ getHasSignedIn: async () => hasSignedIn }));

beforeEach(() => {
  vi.resetModules();
  postResult = { ok: true, data: { token: "run-token-xyz" } };
  postCalls = 0;
  signedInImpl = async () => true;
  hasSignedIn = false;
});

describe("fetchRunToken", () => {
  it("returns the token for a signed-in user", async () => {
    const { fetchRunToken } = await import("@/lib/runToken");
    expect(await fetchRunToken()).toEqual({ ok: true, token: "run-token-xyz" });
  });

  // Anonymous callers get null, NOT a failure. The run still starts, on the
  // device identity — signing in is an upgrade, never a gate.
  it("returns null when the user is not signed in", async () => {
    signedInImpl = async () => false;
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

  // `isSignedIn` awaits Clerk's load(), which rejects when Clerk's Frontend
  // API is unreachable — an incident, a paused instance, a proxy blocking the
  // host. The two tests below are the two halves of the asymmetry
  // lib/clerkTokenSource.ts holds for the per-request path; they must keep
  // agreeing with it.

  // THE REGRESSION THIS GUARDS. Anonymous use predates sign-in and cannot be
  // gated on Clerk being reachable. A browser that never signed in has no
  // session to protect, so an outage must be invisible to it: null, and the
  // run proceeds on the device identity exactly as it always did.
  it("proceeds anonymously when Clerk is unreachable and this browser never signed in", async () => {
    signedInImpl = async () => {
      throw new Error("Clerk Frontend API unreachable");
    };
    hasSignedIn = false;
    const { fetchRunToken } = await import("@/lib/runToken");
    expect(await fetchRunToken()).toBeNull();
  });

  // The other half. This browser HAS signed in, so we cannot tell whether the
  // session is still good — and guessing "signed out" would spend the user's
  // 3-per-30-days device trial while the panel showed them their daily
  // allowance. Report it and let the panel refuse.
  it("refuses when Clerk is unreachable and this browser has signed in before", async () => {
    signedInImpl = async () => {
      throw new Error("Clerk Frontend API unreachable");
    };
    hasSignedIn = true;
    const { fetchRunToken } = await import("@/lib/runToken");
    expect(await fetchRunToken()).toMatchObject({
      ok: false,
      kind: "session_expired",
    });
  });

  // Neither half reaches the mint endpoint. A request sent with an identity
  // we could not confirm is the thing this module exists to avoid, and it
  // would also turn one outage into two round trips.
  it("does not call the mint endpoint when Clerk is unreachable", async () => {
    signedInImpl = async () => {
      throw new Error("Clerk Frontend API unreachable");
    };
    const { fetchRunToken } = await import("@/lib/runToken");

    hasSignedIn = false;
    await fetchRunToken();
    hasSignedIn = true;
    await fetchRunToken();

    expect(postCalls).toBe(0);
  });
});
