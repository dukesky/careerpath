import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { GapAnalysis } from "@shared/contract";
import { QuestionCards } from "../QuestionCards";

/**
 * This package has no `@testing-library/react` (see App.test.tsx's module doc
 * for why: `react-dom` already ships `createRoot` and `act`, and adding the
 * library would be convenience rather than capability). So the brief's
 * `render`/`screen`/`fireEvent` cases are expressed here against the platform
 * directly — same three behaviors, same assertions.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ANALYSIS: GapAnalysis = {
  overall_match_score: 60,
  rationale: "",
  strengths: [],
  gaps: [],
  requirements_matrix: [
    {
      requirement: "Kubernetes",
      kind: "must_have",
      status: "partially_met",
      evidence: "",
      suggestion: "name the operator work",
    },
    { requirement: "Rust", kind: "nice_to_have", status: "missing", evidence: "", suggestion: "" },
    { requirement: "TypeScript", kind: "must_have", status: "met", evidence: "5y", suggestion: "" },
  ],
};

describe("QuestionCards", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  async function renderCards(props: {
    disabled: boolean;
    onImprove: (answersText: string) => void;
  }) {
    await act(async () => {
      root.render(<QuestionCards analysis={ANALYSIS} {...props} />);
    });
  }

  /** The card headings — one <strong> per rendered requirement row. */
  function headings(): string[] {
    return Array.from(container.querySelectorAll("li > strong")).map(
      (el) => el.textContent?.trim() ?? "",
    );
  }

  function improveButton(): HTMLButtonElement {
    const btn = Array.from(container.querySelectorAll("button")).find((b) =>
      /improve/i.test(b.textContent ?? ""),
    );
    if (!btn) {
      const labels = Array.from(container.querySelectorAll("button")).map((b) =>
        b.textContent?.trim(),
      );
      throw new Error(`no "improve" button. Present: ${JSON.stringify(labels)}`);
    }
    return btn;
  }

  // Same reasoning as App.test.tsx's `typeInto`: a raw `el.value = ...` goes
  // through React's own tracked setter, so the tracker's recorded value and
  // the DOM's actual value match by the time "input" fires and React treats
  // the change as a no-op. The native prototype setter bypasses the tracker.
  function typeInto(el: HTMLTextAreaElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  it("renders one card per missing/partially_met row and none for met rows", async () => {
    await renderCards({ disabled: false, onImprove: () => {} });

    expect(headings()).toContain("Kubernetes");
    expect(headings()).toContain("Rust");
    expect(headings()).not.toContain("TypeScript");
  });

  it("submits only answered rows as 'requirement: answer' lines", async () => {
    const onImprove = vi.fn();
    await renderCards({ disabled: false, onImprove });

    const boxes = container.querySelectorAll("textarea");
    act(() => {
      typeInto(boxes[0] as HTMLTextAreaElement, "wrote a namespace operator in Go");
    });
    await act(async () => {
      improveButton().click();
    });

    expect(onImprove).toHaveBeenCalledWith("Kubernetes: wrote a namespace operator in Go");
  });

  it("disables the button when nothing is answered or when disabled", async () => {
    await renderCards({ disabled: false, onImprove: () => {} });
    expect(improveButton().disabled).toBe(true);

    // Answering it lights the button up — otherwise the assertion above and
    // the one below would both pass on a button that is simply always dead.
    act(() => {
      typeInto(container.querySelector("textarea") as HTMLTextAreaElement, "real experience");
    });
    expect(improveButton().disabled).toBe(false);

    // Same answered state, but the panel is busy now — still inert, or a
    // second run would be queued on top of the one already in flight.
    await renderCards({ disabled: true, onImprove: () => {} });
    expect(improveButton().disabled).toBe(true);
  });
});
