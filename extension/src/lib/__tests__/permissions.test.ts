import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  BROAD_ORIGINS,
  classifyInjectionError,
  hasBroadHostAccess,
  requestBroadHostAccess,
} from "@/lib/permissions";

describe("classifyInjectionError", () => {
  // Chrome's own wording, captured from a real failure during the
  // investigation that produced this plan.
  it("classifies a missing host permission", () => {
    const err = new Error(
      "Cannot access contents of the page. Extension manifest must request permission to access the respective host.",
    );
    expect(classifyInjectionError(err)).toBe("permission");
  });

  it("classifies a chrome:// page as restricted", () => {
    expect(classifyInjectionError(new Error("Cannot access a chrome:// URL"))).toBe(
      "restricted",
    );
  });

  it("classifies the Web Store as restricted", () => {
    expect(
      classifyInjectionError(
        new Error("The extensions gallery cannot be scripted."),
      ),
    ).toBe("restricted");
  });

  it("defaults an unrecognised error to unknown, not permission", () => {
    expect(classifyInjectionError(new Error("something else entirely"))).toBe(
      "unknown",
    );
    expect(classifyInjectionError("not an error object")).toBe("unknown");
    expect(classifyInjectionError(undefined)).toBe("unknown");
  });

  // A real failure mode: the content script injected, but sendMessage raced
  // a navigation and no listener answered. This is not a permission problem
  // — the host may already be granted — so it must not route to "permission".
  it("classifies a lost-connection sendMessage failure as unknown", () => {
    const err = new Error(
      "Could not establish connection. Receiving end does not exist.",
    );
    expect(classifyInjectionError(err)).toBe("unknown");
  });

  // file:// (and view-source:/about:) cannot be granted by
  // chrome.permissions.request — file access is a separate Chrome checkbox —
  // so these must be "restricted", not "permission".
  it("classifies a file:// page as restricted", () => {
    expect(
      classifyInjectionError(new Error("Cannot access contents of file:///Users/x/resume.pdf")),
    ).toBe("restricted");
  });
});

describe("host access", () => {
  beforeEach(() => {
    vi.stubGlobal("chrome", {
      permissions: {
        contains: vi.fn(async () => false),
        request: vi.fn(async () => true),
      },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("asks about exactly the declared broad origins", async () => {
    await hasBroadHostAccess();
    expect(chrome.permissions.contains).toHaveBeenCalledWith({
      origins: BROAD_ORIGINS,
    });
  });

  it("reports whether the grant is already held", async () => {
    expect(await hasBroadHostAccess()).toBe(false);
    // Cast away the ambient `contains` overload set before handing it to
    // `vi.mocked`: TS infers a conditional type like `Mock<T>`'s
    // `ReturnType<T>` from the LAST overload of an overloaded function, which
    // here is the callback-based `(perms, cb) => void` form — so without this
    // cast `mockResolvedValue` would expect `void`, not `boolean`.
    vi.mocked(
      chrome.permissions.contains as (p: chrome.permissions.Permissions) => Promise<boolean>,
    ).mockResolvedValue(true);
    expect(await hasBroadHostAccess()).toBe(true);
  });

  it("returns the grant outcome from a request", async () => {
    expect(await requestBroadHostAccess()).toBe(true);
    // Same overload-inference cast as above, for `request`.
    vi.mocked(
      chrome.permissions.request as (p: chrome.permissions.Permissions) => Promise<boolean>,
    ).mockResolvedValue(false);
    expect(await requestBroadHostAccess()).toBe(false);
  });

  it("treats a rejected permissions call as 'not granted' rather than throwing", async () => {
    vi.mocked(chrome.permissions.contains).mockRejectedValue(new Error("nope"));
    vi.mocked(chrome.permissions.request).mockRejectedValue(new Error("nope"));
    await expect(hasBroadHostAccess()).resolves.toBe(false);
    await expect(requestBroadHostAccess()).resolves.toBe(false);
  });
});
