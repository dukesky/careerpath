import { describe, it, expect, beforeEach, vi } from "vitest";
import { getResume, setResume, clearResume, getToken, setToken, clearToken } from "@/lib/storage";
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

  it("survives corrupt stored JSON rather than throwing", async () => {
    await chrome.storage.local.set({ cp_resume: "not json" });
    expect(await getResume()).toBeNull();
  });
});
