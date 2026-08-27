import { describe, it, expect, beforeEach, vi } from "vitest";

let onCreatedCb: ((tab: { id?: number }) => void) | undefined;
let setOptionsCalls: Array<{ tabId?: number; path?: string; enabled?: boolean }> = [];

beforeEach(() => {
  setOptionsCalls = [];
  onCreatedCb = undefined;
  vi.resetModules();
  vi.stubGlobal("chrome", {
    sidePanel: {
      setPanelBehavior: vi.fn(async () => {}),
      setOptions: vi.fn(async (o: { tabId?: number; path?: string }) => {
        setOptionsCalls.push(o);
      }),
    },
    tabs: { onCreated: { addListener: vi.fn((cb) => { onCreatedCb = cb; }) } },
    runtime: {
      onInstalled: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn() },
      onMessage: { addListener: vi.fn() },
    },
  });
});

describe("per-tab side panel", () => {
  it("gives each new tab its own panel instance", async () => {
    await import("../index");
    onCreatedCb?.({ id: 42 });
    await new Promise((r) => setTimeout(r, 0));

    expect(setOptionsCalls).toContainEqual({
      tabId: 42,
      path: "src/sidepanel/index.html",
      enabled: true,
    });
  });

  // Reading tab.url would require the `tabs` permission this project has
  // deliberately declined. A tabId is all this needs.
  it("never inspects the tab's URL", async () => {
    await import("../index");
    const tab: { id?: number; url?: string } = { id: 42 };
    Object.defineProperty(tab, "url", {
      get() { throw new Error("read tab.url"); },
    });

    expect(() => onCreatedCb?.(tab)).not.toThrow();
  });
});
