import { describe, it, expect, beforeEach, vi } from "vitest";
import { currentAuthToken, setClerkTokenSource } from "@/lib/session";

vi.mock("@/lib/token", () => ({
  ensureToken: vi.fn(async () => "device-token"),
}));

// currentAuthToken() warns when the Clerk source throws — deliberate and
// load-bearing in production (see task-2-report.md's fix report). Here it
// would just be console noise, so silence it and let the assertions below
// cover the behavior instead.
vi.spyOn(console, "warn").mockImplementation(() => {});

describe("currentAuthToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setClerkTokenSource(async () => ({ signedIn: false }));
  });

  it("uses the device token when there is no Clerk session", async () => {
    expect(await currentAuthToken()).toEqual({
      kind: "device",
      token: "device-token",
    });
  });

  // Signed in, the Clerk token WINS. Sending the device token instead would
  // land the request in the 3-per-30-days bucket while the panel shows a
  // signed-in user their daily allowance.
  it("prefers the Clerk token when there is a session", async () => {
    setClerkTokenSource(async () => ({ signedIn: true, token: "clerk-token" }));
    expect(await currentAuthToken()).toEqual({
      kind: "clerk",
      token: "clerk-token",
    });
  });

  // Signed in, and Clerk says so, but there is no token to hand back. This is
  // NOT "signed out" — collapsing it into a bare null (and therefore into the
  // device fallback) is exactly the silent downgrade this module exists to
  // prevent: the device token would sail through, the run would be charged to
  // the 3-per-30-days bucket, and nothing would look broken. `ensureToken`
  // must not even be called — spending a device mint on an identity we can't
  // attribute is the bug, not just returning the wrong kind.
  it("reports session_unavailable when signed in but Clerk has no token", async () => {
    setClerkTokenSource(async () => ({ signedIn: true, token: null }));
    expect(await currentAuthToken()).toEqual({ kind: "session_unavailable" });
    const { ensureToken } = await import("@/lib/token");
    expect(ensureToken).not.toHaveBeenCalled();
  });

  // A Clerk source that throws must not take the request down with it, but it
  // must also not silently guess "signed out" and spend the user's device
  // trial in its place — a throw tells us nothing about which one is true.
  // This replaces the module's original "falls back to the device token"
  // behavior: that fallback WAS the bug (see task-2-report.md's fix report) —
  // a thrown Clerk source produced a valid device token that never 401s, so
  // the run succeeded silently against the wrong bucket.
  it("reports session_unavailable when the Clerk source throws", async () => {
    setClerkTokenSource(async () => {
      throw new Error("clerk unavailable");
    });
    expect(await currentAuthToken()).toEqual({ kind: "session_unavailable" });
    const { ensureToken } = await import("@/lib/token");
    expect(ensureToken).not.toHaveBeenCalled();
  });

  it("returns null when neither identity is available", async () => {
    const { ensureToken } = await import("@/lib/token");
    vi.mocked(ensureToken).mockResolvedValueOnce(null);
    expect(await currentAuthToken()).toBeNull();
  });
});
