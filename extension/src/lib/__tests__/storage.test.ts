import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getResume,
  setResume,
  clearResume,
  getToken,
  setToken,
  clearToken,
  getHasSignedIn,
  markSignInCompleted,
  setHasSignedIn,
  HAS_SIGNED_IN_KEY,
  SIGNIN_SIGNAL_KEY,
} from "@/lib/storage";
import type { ParsedResume } from "@shared/contract";

const EMPTY: ParsedResume = {
  contact: { name: "Ada Lovelace", email: "", phone: "", location: "", links: [] },
  summary: "",
  experience: [],
  projects: [],
  skills: [],
  education: [],
};

function fakeChromeStorage() {
  const data: Record<string, unknown> = {};
  return {
    storage: {
      local: {
        get: vi.fn(async (keys: string[]) => {
          const out: Record<string, unknown> = {};
          for (const k of keys) if (k in data) out[k] = data[k];
          return out;
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(data, items);
        }),
        remove: vi.fn(async (keys: string[]) => {
          for (const k of keys) delete data[k];
        }),
      },
    },
  };
}

describe("extension storage", () => {
  beforeEach(() => {
    vi.stubGlobal("chrome", fakeChromeStorage());
  });

  it("returns null when no resume is stored", async () => {
    expect(await getResume()).toBeNull();
  });

  it("round-trips a stored resume", async () => {
    await setResume({ resume: EMPTY, parsedAt: "2026-08-11T00:00:00.000Z", name: "Ada Lovelace" });
    const got = await getResume();
    expect(got?.name).toBe("Ada Lovelace");
    expect(got?.resume.contact.name).toBe("Ada Lovelace");
  });

  it("clears a stored resume", async () => {
    await setResume({ resume: EMPTY, parsedAt: "x", name: "Ada" });
    await clearResume();
    expect(await getResume()).toBeNull();
  });

  it("round-trips and clears the device token", async () => {
    expect(await getToken()).toBeNull();
    await setToken("tok-123");
    expect(await getToken()).toBe("tok-123");
    await clearToken();
    expect(await getToken()).toBeNull();
  });

  // FINAL-REVIEW (C1): the sign-in page's notification to the panel must be
  // a value that CHANGES, on a key nothing else writes. `cp_has_signed_in` is
  // already true on any browser that has signed in before, and Chrome fires
  // no storage.onChanged for a write that leaves a value unchanged — so a
  // signal sharing that key is inert for exactly the returning users it is
  // meant to serve.
  it("stamps the sign-in signal with a timestamp on its own key, separate from the has-signed-in flag", async () => {
    await setHasSignedIn();
    const before = Date.now();
    await markSignInCompleted();

    const got = await chrome.storage.local.get([SIGNIN_SIGNAL_KEY, HAS_SIGNED_IN_KEY]);
    expect(SIGNIN_SIGNAL_KEY).not.toBe(HAS_SIGNED_IN_KEY);
    expect(typeof got[SIGNIN_SIGNAL_KEY]).toBe("number");
    expect(got[SIGNIN_SIGNAL_KEY] as number).toBeGreaterThanOrEqual(before);
    // The durable hint lib/clerk.ts reads is untouched by the signal.
    expect(await getHasSignedIn()).toBe(true);
  });

  it("survives corrupt stored JSON rather than throwing", async () => {
    await chrome.storage.local.set({ cp_resume: "not json" });
    expect(await getResume()).toBeNull();
  });
});
