import { describe, it, expect, beforeEach, vi } from "vitest";

// The backfill tests below invoke background/index.ts's REAL onInstalled
// callback, which also calls ensureToken(). Unmocked, that fires a genuine
// `POST http://localhost:3000/api/device-token`: in CI the connection is
// refused and token.ts swallows it, but on a developer machine with the web
// app running it mints a live device token as a side effect of running the
// test suite. Nothing here asserts on tokens, so stub the whole module.
vi.mock("@/lib/token", () => ({
  ensureToken: vi.fn(async () => "test-device-token"),
}));

let onCreatedCb: ((tab: { id?: number }) => void) | undefined;
let onInstalledCb: (() => void) | undefined;
let setOptionsCalls: Array<{ tabId?: number; path?: string; enabled?: boolean }> = [];
let queryResult: Array<{ id?: number }> = [];

beforeEach(() => {
  setOptionsCalls = [];
  onCreatedCb = undefined;
  onInstalledCb = undefined;
  queryResult = [];
  vi.resetModules();
  vi.stubGlobal("chrome", {
    sidePanel: {
      setPanelBehavior: vi.fn(async () => {}),
      setOptions: vi.fn(async (o: { tabId?: number; path?: string }) => {
        setOptionsCalls.push(o);
      }),
    },
    tabs: {
      onCreated: { addListener: vi.fn((cb) => { onCreatedCb = cb; }) },
      query: vi.fn(async () => queryResult),
    },
    runtime: {
      onInstalled: { addListener: vi.fn((cb) => { onInstalledCb = cb; }) },
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

describe("backfill for tabs that predate the listener", () => {
  // `tabs.onCreated` only covers tabs opened after the listener registers.
  // Without a backfill on install/startup, every tab already open — including
  // the one the user was looking at when they installed the extension — stays
  // on the shared, window-global panel indefinitely.
  it("gives every existing tab its own panel instance", async () => {
    queryResult = [{ id: 1 }, { id: 2 }];
    await import("../index");
    onInstalledCb?.();
    await new Promise((r) => setTimeout(r, 0));

    expect(setOptionsCalls).toContainEqual({
      tabId: 1,
      path: "src/sidepanel/index.html",
      enabled: true,
    });
    expect(setOptionsCalls).toContainEqual({
      tabId: 2,
      path: "src/sidepanel/index.html",
      enabled: true,
    });
  });

  // `tabs.query({})` needs no `tabs` permission and returns `url` stripped —
  // but only as long as nothing here tries to read it.
  it("never inspects the URL of an existing tab either", async () => {
    const tab: { id?: number; url?: string } = { id: 1 };
    Object.defineProperty(tab, "url", {
      get() { throw new Error("read tab.url"); },
    });
    queryResult = [tab];
    await import("../index");

    expect(() => onInstalledCb?.()).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));

    expect(setOptionsCalls).toContainEqual({
      tabId: 1,
      path: "src/sidepanel/index.html",
      enabled: true,
    });
  });
});
