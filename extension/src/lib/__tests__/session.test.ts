import { describe, it, expect, beforeEach, vi } from "vitest";
import { currentAuthToken, setClerkTokenSource } from "@/lib/session";

vi.mock("@/lib/token", () => ({
  ensureToken: vi.fn(async () => "device-token"),
}));

describe("currentAuthToken", () => {
  beforeEach(() => {
    setClerkTokenSource(async () => null);
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
    setClerkTokenSource(async () => "clerk-token");
    expect(await currentAuthToken()).toEqual({
      kind: "clerk",
      token: "clerk-token",
    });
  });

  // A Clerk source that throws must not take the request down with it, but it
  // must also not silently pretend the user is signed out and spend their
  // device trial. Falling back to the device token is the lesser evil only
  // because the 401 fork downstream still tells a signed-in user the truth.
  it("falls back to the device token when the Clerk source throws", async () => {
    setClerkTokenSource(async () => {
      throw new Error("clerk unavailable");
    });
    expect(await currentAuthToken()).toEqual({
      kind: "device",
      token: "device-token",
    });
  });

  it("returns null when neither identity is available", async () => {
    const { ensureToken } = await import("@/lib/token");
    vi.mocked(ensureToken).mockResolvedValueOnce(null);
    expect(await currentAuthToken()).toBeNull();
  });
});
