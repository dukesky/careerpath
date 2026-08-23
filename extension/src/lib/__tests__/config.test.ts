import { describe, it, expect, vi, afterEach } from "vitest";

// CLERK_PUBLISHABLE_KEY and CLERK_FRONTEND_API are two literals that must
// describe the same Clerk instance, per build mode, with nothing at compile
// time tying them together. A publishable key encodes its instance's
// Frontend API host (base64 of "<host>$" after the pk_ prefix), so the pair
// can be checked mechanically: decode the key and compare it to the host.
// This catches the key being rotated without the host (or vice versa), and
// a production build accidentally shipping a pk_test_ key.

function hostFromPublishableKey(key: string): string {
  const encoded = key.replace(/^pk_(live|test)_/, "");
  return atob(encoded).replace(/\$$/, "");
}

async function loadConfig(mode: string) {
  vi.stubEnv("MODE", mode);
  vi.resetModules();
  return import("@/lib/config");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("Clerk config", () => {
  it("production uses a live key that encodes the production Frontend API host", async () => {
    const { CLERK_PUBLISHABLE_KEY, CLERK_FRONTEND_API } =
      await loadConfig("production");
    expect(CLERK_PUBLISHABLE_KEY).toMatch(/^pk_live_/);
    expect(hostFromPublishableKey(CLERK_PUBLISHABLE_KEY)).toBe(
      new URL(CLERK_FRONTEND_API).host,
    );
    expect(CLERK_FRONTEND_API).toBe("https://clerk.career-allpath.com");
  });

  it("development uses a test key that encodes the development Frontend API host", async () => {
    const { CLERK_PUBLISHABLE_KEY, CLERK_FRONTEND_API } =
      await loadConfig("development");
    expect(CLERK_PUBLISHABLE_KEY).toMatch(/^pk_test_/);
    expect(hostFromPublishableKey(CLERK_PUBLISHABLE_KEY)).toBe(
      new URL(CLERK_FRONTEND_API).host,
    );
  });
});
