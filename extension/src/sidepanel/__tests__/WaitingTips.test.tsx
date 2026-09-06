import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TIPS } from "../tips";
import { TIP_ROTATION_MS, WaitingTips } from "../WaitingTips";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The tips card is the only thing on screen during the part of a run that has
 * nothing to show yet, so its two failure modes are both silent: a card that
 * never rotates (the user reads the same sentence for a minute) and a card
 * that outlives the wait (advice sitting under a finished result). Both are
 * asserted here rather than left to the eye.
 */
describe("WaitingTips", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  function render(active: boolean) {
    act(() => {
      root.render(<WaitingTips active={active} />);
    });
  }

  /** The tip sentence currently on screen, without the icon or the category tag. */
  function shown(): string {
    return container.querySelector(".tip-text")?.textContent?.trim() ?? "";
  }

  function tick() {
    act(() => {
      vi.advanceTimersByTime(TIP_ROTATION_MS);
    });
  }

  it("shows a tip while active and nothing at all while inactive", () => {
    render(true);
    expect(container.querySelector(".tip-card")).toBeTruthy();
    expect(shown().length).toBeGreaterThan(0);

    render(false);
    expect(container.querySelector(".tip-card")).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("rotates to a different tip on every interval", () => {
    render(true);
    const first = shown();
    // Just short of the interval: still the first tip. Guards against an
    // interval that was shortened to make a test pass.
    act(() => {
      vi.advanceTimersByTime(TIP_ROTATION_MS - 1);
    });
    expect(shown()).toBe(first);
    tick();
    expect(shown()).not.toBe(first);
  });

  it("does not repeat a tip until the whole deck has been shown", () => {
    render(true);
    const seen = [shown()];
    for (let i = 1; i < TIPS.length; i++) {
      tick();
      seen.push(shown());
    }
    expect(new Set(seen).size).toBe(TIPS.length);
    // And it keeps going once the deck is exhausted rather than sticking on
    // the last card.
    tick();
    expect(shown().length).toBeGreaterThan(0);
  });

  it("stops its interval when it unmounts", () => {
    render(true);
    const clear = vi.spyOn(globalThis, "clearInterval");
    act(() => root.unmount());
    expect(clear).toHaveBeenCalled();
    clear.mockRestore();
    // Re-create the root the afterEach unmounts, so the teardown stays valid.
    root = createRoot(container);
  });

  it("stops rotating as soon as it goes inactive", () => {
    render(true);
    render(false);
    // No node to update; the assertion is that advancing time does not throw
    // an act() warning about a setState on an unmounted subtree, and that
    // nothing comes back on screen by itself.
    act(() => {
      vi.advanceTimersByTime(TIP_ROTATION_MS * 3);
    });
    expect(container.querySelector(".tip-card")).toBeNull();
  });
});

describe("TIPS content", () => {
  it("carries a deck deep enough that a long wait never loops", () => {
    expect(TIPS.length).toBeGreaterThanOrEqual(18);
  });

  it("covers all four stages of an application", () => {
    const categories = new Set(TIPS.map((t) => t.category));
    expect(categories).toEqual(new Set(["applying", "resume", "interview", "follow-up"]));
  });

  it("has real, distinct advice in every entry", () => {
    for (const tip of TIPS) {
      expect(tip.text.trim().length).toBeGreaterThan(20);
    }
    expect(new Set(TIPS.map((t) => t.text)).size).toBe(TIPS.length);
  });
});
