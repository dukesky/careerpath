import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { GapAnalysis, ParsedResume, TailorResult } from "@shared/contract";
import { INITIAL_RUN_STATE } from "@/lib/run";
import { Results } from "../Results";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RESUME: ParsedResume = {
  contact: { name: "Ada", email: "", phone: "", location: "", links: [] },
  summary: "",
  experience: [],
  projects: [],
  skills: [],
  education: [],
};

const ANALYSIS: GapAnalysis = {
  overall_match_score: 60,
  rationale: "",
  strengths: [],
  gaps: [],
  requirements_matrix: [
    { requirement: "Kubernetes", kind: "must_have", status: "missing", evidence: "", suggestion: "" },
  ],
};

const TAILORED: TailorResult = { resume: RESUME, change_log: [], projected_match_score: 70 };

/**
 * Covers Results.tsx's half of the uplift pipeline — the two things
 * QuestionCards.test.tsx cannot see, because they are about where the
 * component is MOUNTED rather than what it does once mounted.
 *
 * App.test.tsx cannot cover them either: its `analysisFixture` builds an
 * empty `requirements_matrix`, so QuestionCards returns null in every test
 * there, and the mount condition and the refining hint would both be free to
 * regress silently.
 */
describe("Results - uplift wiring", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  async function renderResults(over: Partial<Parameters<typeof Results>[0]> = {}) {
    const onImprove = vi.fn();
    await act(async () => {
      root.render(
        <Results
          state={{ ...INITIAL_RUN_STATE, phase: "done", analysis: ANALYSIS, tailored: TAILORED }}
          company=""
          roleTitle=""
          jdSummary=""
          jdUrl={undefined}
          signedIn={false}
          saving={false}
          onSavingChange={() => {}}
          generatedAt={null}
          baselineScore={60}
          appliedSupplement=""
          canRun
          onImprove={onImprove}
          supplement={{ text: "", onChange: () => {}, onSubmit: () => {}, busy: false, canRun: true }}
          {...over}
        />,
      );
    });
    return onImprove;
  }

  it("mounts the question cards on a finished run and forwards their answers", async () => {
    const onImprove = await renderResults();
    expect(container.textContent).toContain("Raise your score with real experience");
    const ta = Array.from(container.querySelectorAll("textarea")).find(
      (t) => !t.classList.contains("paste"),
    )!;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    act(() => {
      setter.call(ta, "ran a k8s cluster");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const btn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Improve my score",
    )!;
    await act(async () => btn.click());
    expect(onImprove).toHaveBeenCalledWith("Kubernetes: ran a k8s cluster");
  });

  // The `.score` assertion is the point of the second half: that element's
  // text is asserted verbatim in several App tests ("72 → 82 match"), so the
  // hint has to sit OUTSIDE it or it silently breaks them.
  it("shows the refining hint only while refining, and never inside .score", async () => {
    await renderResults();
    expect(container.textContent).not.toContain("Improving the rewrite");
    await renderResults({
      state: {
        ...INITIAL_RUN_STATE,
        phase: "done",
        analysis: ANALYSIS,
        tailored: TAILORED,
        refining: true,
      },
    });
    expect(container.textContent).toContain("Improving the rewrite against the gaps…");
    expect(container.querySelector(".score")?.textContent).toBe("60 → 70 match");
  });

  it("hides the cards before the rewrite exists", async () => {
    await renderResults({
      state: { ...INITIAL_RUN_STATE, phase: "comparing", analysis: ANALYSIS, tailored: null },
    });
    expect(container.textContent).not.toContain("Raise your score with real experience");
  });
});
