import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/token", () => ({ ensureToken: vi.fn(async () => "test-device-token") }));
vi.mock("@clerk/chrome-extension/background", () => ({
  createClerkClient: async () => ({ isSignedIn: false, session: null }),
}));

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("chrome", {
    sidePanel: { setPanelBehavior: vi.fn(async () => {}), setOptions: vi.fn(async () => {}) },
    tabs: { onCreated: { addListener: vi.fn() }, query: vi.fn(async () => []) },
    runtime: {
      onInstalled: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn() },
      onMessage: { addListener: vi.fn() },
    },
    storage: {
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
      onChanged: { addListener: vi.fn() },
    },
  });
});

/**
 * THE REGRESSION TEST FOR THIS ENTIRE PLAN.
 *
 * session.ts's `clerkTokenSource` is a module-level variable that defaults to
 * signed-out, and the service worker is a JS realm of its own. For the whole
 * life of the background-runs feature nothing in the worker replaced that
 * default, so every run transacted as the device and no user's quota was ever
 * charged — with every test in the suite green, because no test asked whether
 * the worker had an identity. This one asks.
 */
describe("the service worker's identity", () => {
  it("installs a Clerk token source when the worker starts", async () => {
    const session = await import("@/lib/session");
    const spy = vi.spyOn(session, "setClerkTokenSource");

    await import("../index");

    expect(spy).toHaveBeenCalled();
  });
});
