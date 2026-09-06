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

/** The honest-ceiling shape: every must_have already met. */
const ALL_MET: GapAnalysis = {
  ...ANALYSIS,
  requirements_matrix: [
    { requirement: "Kubernetes", kind: "must_have", status: "met", evidence: "", suggestion: "" },
    { requirement: "Go", kind: "must_have", status: "met", evidence: "", suggestion: "" },
    { requirement: "Terraform", kind: "nice_to_have", status: "missing", evidence: "", suggestion: "" },
  ],
};

const CEILING_NOTE =
  "All 2 must-have requirements are already met — the score is near its honest ceiling for this role.";

/** The same note for a JD with a single must-have, which reads in the singular. */
const CEILING_NOTE_ONE =
  "All 1 must-have requirement is already met — the score is near its honest ceiling for this role.";

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
    // Addressed by the requirement it belongs to. The panel's textareas all
    // share the `paste` class, so "the one that isn't the supplement box" is
    // not a durable way to find this one.
    const ta = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Kubernetes"]')!;
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
  //
  // `rescoredScore` is set because this is the AUTO-REFINE tail, and that leg
  // runs with a measured number already published (run.ts sends `first.patch`
  // before raising `refining`). Refining with the slot still empty is the
  // repair leg, a different state with its own copy — see "Results - score
  // floor display" below.
  it("shows the refining hint only while refining, and never inside .score", async () => {
    await renderResults();
    expect(container.textContent).not.toContain("Improving the rewrite");
    await renderResults({
      state: {
        ...INITIAL_RUN_STATE,
        phase: "done",
        analysis: ANALYSIS,
        tailored: TAILORED,
        rescoredScore: 70,
        refining: true,
      },
    });
    expect(container.textContent).toContain("Improving the rewrite against the gaps…");
    expect(container.querySelector(".score")?.textContent).toBe("60 → 70 match");
  });

  // The right-hand number legitimately does not move when every must-have is
  // already met — there is no truthful rewrite left that would raise it. Said
  // out loud, that is an honest ceiling; left unsaid, it reads as a broken
  // feature, so the card explains itself.
  it("explains the honest ceiling when every must-have is met", async () => {
    await renderResults({
      state: { ...INITIAL_RUN_STATE, phase: "done", analysis: ALL_MET, tailored: TAILORED },
    });
    expect(container.textContent).toContain(CEILING_NOTE);
  });

  // A one-must-have JD is common (a single hard credential or language), and
  // the plural read as a bug in the panel rather than as English.
  it("says it in the singular when the JD has exactly one must-have", async () => {
    await renderResults({
      state: {
        ...INITIAL_RUN_STATE,
        phase: "done",
        analysis: {
          ...ALL_MET,
          requirements_matrix: [ALL_MET.requirements_matrix[0], ALL_MET.requirements_matrix[2]],
        },
        tailored: TAILORED,
      },
    });
    expect(container.textContent).toContain(CEILING_NOTE_ONE);
  });

  it("stays silent when a must-have is still short, or when there are none at all", async () => {
    // ANALYSIS's single must_have is `missing` — the ordinary case.
    await renderResults();
    expect(container.textContent).not.toContain("honest ceiling");

    await renderResults({
      state: {
        ...INITIAL_RUN_STATE,
        phase: "done",
        analysis: {
          ...ALL_MET,
          requirements_matrix: [
            { ...ALL_MET.requirements_matrix[0], status: "partially_met" },
            ALL_MET.requirements_matrix[1],
          ],
        },
        tailored: TAILORED,
      },
    });
    expect(container.textContent).not.toContain("honest ceiling");

    // No must_have rows at all: "All 0 must-have requirements are already met"
    // would be a claim about nothing.
    await renderResults({
      state: {
        ...INITIAL_RUN_STATE,
        phase: "done",
        analysis: { ...ALL_MET, requirements_matrix: [ALL_MET.requirements_matrix[2]] },
        tailored: TAILORED,
      },
    });
    expect(container.textContent).not.toContain("honest ceiling");
  });

  // Same fixture note as above: `rescoredScore` set makes this the auto-refine
  // tail rather than the repair wait.
  it("stays silent while the refine leg is still running", async () => {
    await renderResults({
      state: {
        ...INITIAL_RUN_STATE,
        phase: "done",
        analysis: ALL_MET,
        tailored: TAILORED,
        rescoredScore: 70,
        refining: true,
      },
    });
    expect(container.textContent).not.toContain("honest ceiling");
    expect(container.textContent).toContain("Improving the rewrite against the gaps…");
  });

  it("hides the cards before the rewrite exists", async () => {
    await renderResults({
      state: { ...INITIAL_RUN_STATE, phase: "comparing", analysis: ANALYSIS, tailored: null },
    });
    expect(container.textContent).not.toContain("Raise your score with real experience");
  });
});

/**
 * The score floor's four display states.
 *
 * Each one is a different answer to the same question — "why is the
 * right-hand number what it is?" — and the panel is the only place that
 * answer exists. A held number with no sentence under it is a lie by
 * omission; a lower number with no way forward is a dead end. So each state
 * is pinned here by the exact sentence it shows AND by the colour of the
 * arrow, because "the number held" and "the number improved" must not look
 * alike.
 */
describe("Results - score floor display", () => {
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

  /** A finished run whose rescore has been decided, however the caller says. */
  async function renderScore(state: Partial<Parameters<typeof Results>[0]["state"]>) {
    await act(async () => {
      root.render(
        <Results
          state={{
            ...INITIAL_RUN_STATE,
            phase: "done",
            analysis: ANALYSIS,
            tailored: TAILORED,
            ...state,
          }}
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
          onImprove={() => {}}
          supplement={{ text: "", onChange: () => {}, onSubmit: () => {}, busy: false, canRun: true }}
        />,
      );
    });
  }

  // "maintained": the second read came back lower, but not one requirement
  // got worse, so run.ts holds the number at the left score. Green would
  // claim an improvement that was never measured; red would claim a loss
  // that never happened. Neutral is the only honest colour.
  it("holds the number in a neutral arrow and says why, when nothing got worse", async () => {
    await renderScore({ rescoredScore: 60, scoreNote: "maintained" });
    expect(container.querySelector(".score")?.textContent).toBe("60 → 60 match");
    expect(container.querySelector(".score .after-neutral")).toBeTruthy();
    expect(container.querySelector(".score .after")).toBeNull();
    expect(container.textContent).toContain(
      "Re-measured within the ruler's precision — every requirement holds; presentation improved.",
    );
  });

  // "nice_dip": the number still holds, so the sentence under it has to name
  // what it is holding OVER — otherwise the panel is quietly hiding a row the
  // user had and lost. The extra rows are counted, not listed: a wall of
  // names under a 28px number buries the one that matters.
  it("names the softened nice-to-have, and counts the rest", async () => {
    await renderScore({
      rescoredScore: 60,
      scoreNote: "nice_dip",
      downgradedRequirements: ["Terraform", "Helm charts", "Bash"],
    });
    expect(container.querySelector(".score")?.textContent).toBe("60 → 60 match");
    expect(container.querySelector(".score .after-neutral")).toBeTruthy();
    expect(container.textContent).toContain(
      'One nice-to-have reads softer on the second pass: "Terraform" and 2 more — core requirements all hold.',
    );
  });

  // "downgraded": the ONE display allowed to go down. It gets the ordinary
  // arrow, because the drop is real and measured, and it gets a way forward —
  // the question cards below it are what actually raises the number back.
  it("shows the lower number honestly, names the row, and points at the cards", async () => {
    await renderScore({
      rescoredScore: 55,
      scoreNote: "downgraded",
      downgradedRequirements: ["Kubernetes"],
    });
    expect(container.querySelector(".score")?.textContent).toBe("60 → 55 match");
    expect(container.querySelector(".score .after")).toBeTruthy();
    expect(container.querySelector(".score .after-neutral")).toBeNull();
    expect(container.textContent).toContain(
      'The rewrite reads weaker on: "Kubernetes". Try the question cards below — real detail there raises it back.',
    );
    expect(container.textContent).toContain("Raise your score with real experience");
  });

  // The repair leg's own window: `refining` is up and NO number has been
  // published yet, deliberately — run.ts withholds the dipped measurement
  // rather than showing a number it is about to replace. The slot still has
  // to be occupied, or the card reads as one that lost its second number.
  it("holds the slot on a pulsing placeholder while the repair leg runs", async () => {
    await renderScore({ refining: true });
    expect(container.querySelector(".score .pending-dots")?.textContent).toBe("…");
    expect(container.querySelector(".score")?.textContent).toBe("60 → … match");
    expect(container.textContent).toContain(
      "Taking a second pass at your resume — this usually takes under a minute.",
    );
    // The auto-refine hint is about a number already on screen. There isn't
    // one here, so it would be describing nothing.
    expect(container.textContent).not.toContain("Improving the rewrite against the gaps");
    // Same reasoning as the first-paint window: there is nothing of the
    // user's own to read in this slot yet, so the tips are welcome again.
    expect(container.querySelector(".tip-card")).toBeTruthy();
  });

  // The other refining state, and the reason the two cannot share copy: once
  // a measured number is on screen the leg is an improvement attempt against
  // it, not a wait for it, and the pinned `.score` string must survive.
  it("keeps the auto-refine hint when a measured number is already published", async () => {
    await renderScore({ refining: true, rescoredScore: 70 });
    expect(container.querySelector(".score")?.textContent).toBe("60 → 70 match");
    expect(container.querySelector(".score .pending-dots")).toBeNull();
    expect(container.textContent).toContain("Improving the rewrite against the gaps…");
    expect(container.querySelector(".tip-card")).toBeNull();
  });
});

/**
 * The streamed preview's half of Results.tsx.
 *
 * Every test here is really the same assertion twice: the preview paints when
 * there is nothing better, and it yields the moment there is. The real result
 * winning is not an optimisation — the writing patch does not clear the
 * streaming fields, so a component that preferred them would show a
 * half-arrived matrix beside a finished download button.
 */
describe("Results - streamed preview", () => {
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

  async function render(state: Partial<Parameters<typeof Results>[0]["state"]>) {
    await act(async () => {
      root.render(
        <Results
          state={{ ...INITIAL_RUN_STATE, ...state }}
          company=""
          roleTitle=""
          jdSummary=""
          jdUrl={undefined}
          signedIn
          saving={false}
          onSavingChange={() => {}}
          generatedAt={null}
          baselineScore={null}
          appliedSupplement=""
          canRun
          onImprove={() => {}}
          supplement={{ text: "", onChange: () => {}, onSubmit: () => {}, busy: false, canRun: true }}
        />,
      );
    });
  }

  it("paints a streamed score with no arrow, because there is nothing to point at yet", async () => {
    await render({ phase: "comparing", streamingScore: 62 });
    expect(container.querySelector(".score")?.textContent).toBe("62 match");
  });

  // The pinned string is the contract: several App tests assert `.score`
  // verbatim, so a streamed number must never leak into a card that has a
  // real analysis to show.
  it("yields the score slot to the real analysis the moment it lands", async () => {
    await render({
      phase: "done",
      analysis: ANALYSIS,
      tailored: TAILORED,
      // Deliberately still set: the writing patch does not clear these.
      streamingScore: 62,
    });
    expect(container.querySelector(".score")?.textContent).toBe("60 → 70 match");
  });

  it("paints streamed requirement rows, marked as still arriving", async () => {
    await render({
      phase: "comparing",
      streamingRows: [
        { requirement: "Kubernetes", kind: "must_have", status: "met", evidence: "Ran a cluster", suggestion: "" },
      ],
    });
    expect(container.textContent).toContain("Kubernetes");
    expect(container.textContent).toContain("Ran a cluster");
    expect(container.textContent).toContain("assessing");
  });

  it("yields the requirement list to the real matrix", async () => {
    await render({
      phase: "done",
      analysis: ANALYSIS,
      tailored: TAILORED,
      streamingRows: [
        { requirement: "Streamed only", kind: "must_have", status: "met", evidence: "", suggestion: "" },
      ],
    });
    expect(container.textContent).toContain("Kubernetes");
    expect(container.textContent).not.toContain("Streamed only");
    expect(container.textContent).not.toContain("assessing");
  });

  // A streamed resume is a display, not a result: it has no contact block, it
  // was never measured, and it is not what a download would contain. The gates
  // on the download, the save and the question cards all read `tailored` for
  // exactly that reason, and this test is what keeps them reading it.
  it("previews a streamed resume without offering to download or save it", async () => {
    await render({
      phase: "writing",
      analysis: ANALYSIS,
      streamingResume: {
        contact: { name: "", email: "", phone: "", location: "", links: [] },
        summary: "Platform engineer with eight years on payment systems.",
        experience: [
          { company: "Stripe", title: "Staff Engineer", dates: "", bullets: ["Cut deploy time to six minutes"] },
        ],
        projects: [],
        skills: [],
        education: [],
      },
    });
    expect(container.textContent).toContain("Platform engineer with eight years");
    expect(container.textContent).toContain("Stripe");
    expect(container.textContent).toContain("Staff Engineer");
    expect(container.textContent).toContain("Cut deploy time to six minutes");
    expect(container.textContent).toContain("Drafting");

    const labels = Array.from(container.querySelectorAll("button")).map((b) => b.textContent);
    expect(labels).not.toContain("Download PDF resume");
    expect(labels).not.toContain("Save to career-path");
    expect(container.textContent).not.toContain("Raise your score with real experience");
  });

  it("drops the draft preview once the real rewrite exists", async () => {
    await render({
      phase: "done",
      analysis: ANALYSIS,
      tailored: TAILORED,
      streamingResume: {
        contact: { name: "", email: "", phone: "", location: "", links: [] },
        summary: "A draft summary nobody should still be reading.",
        experience: [],
        projects: [],
        skills: [],
        education: [],
      },
    });
    expect(container.textContent).not.toContain("A draft summary nobody should still be reading.");
    expect(container.textContent).not.toContain("Drafting");
  });

  it("shows waiting tips only until the first substantive thing arrives", async () => {
    await render({ phase: "comparing" });
    expect(container.querySelector(".tip-card")).toBeTruthy();

    // Each of these is enough on its own to retire the tips.
    await render({ phase: "comparing", streamingScore: 62 });
    expect(container.querySelector(".tip-card")).toBeNull();

    await render({
      phase: "comparing",
      streamingRows: [
        { requirement: "Go", kind: "must_have", status: "met", evidence: "", suggestion: "" },
      ],
    });
    expect(container.querySelector(".tip-card")).toBeNull();

    await render({ phase: "done", analysis: ANALYSIS, tailored: TAILORED });
    expect(container.querySelector(".tip-card")).toBeNull();
  });

  it("shows no tips outside a working phase", async () => {
    await render({ phase: "idle" });
    expect(container.querySelector(".tip-card")).toBeNull();
    await render({
      phase: "error",
      error: { kind: "server", message: "Analysis failed." },
    });
    expect(container.querySelector(".tip-card")).toBeNull();
  });
});
