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

  // The two notes are both true and cannot stand together. "The rewrite reads
  // weaker on X — try the question cards" asks the user to do something;
  // "the score is near its honest ceiling" tells them there is nothing left
  // to do. Printed one under the other, the ceiling line reads as the panel
  // withdrawing the ask it just made. The downgrade owns this slot: it is the
  // one that has a way forward attached.
  it("drops the ceiling note under a downgrade, whose CTA it would undercut", async () => {
    await renderResults({
      state: {
        ...INITIAL_RUN_STATE,
        phase: "done",
        analysis: ALL_MET,
        tailored: TAILORED,
        rescoredScore: 55,
        scoreNote: "downgraded",
        downgradedRequirements: ["Terraform"],
      },
    });
    expect(container.textContent).toContain("The rewrite reads weaker on:");
    expect(container.textContent).not.toContain("honest ceiling");
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

  // "downgraded": the ONE display allowed to go down. The number is shown as
  // measured — but NOT in success green. `.after` is the improvement colour,
  // and a drop wearing it reads as a win at a glance, which is the opposite of
  // what the sentence underneath says. Neutral lets the number and its note
  // agree; the way forward is the question cards, not the colour.
  it("shows the lower number honestly in a neutral arrow, names the row, and points at the cards", async () => {
    await renderScore({
      rescoredScore: 55,
      scoreNote: "downgraded",
      downgradedRequirements: ["Kubernetes"],
    });
    expect(container.querySelector(".score")?.textContent).toBe("60 → 55 match");
    expect(container.querySelector(".score .after-neutral")).toBeTruthy();
    expect(container.querySelector(".score .after")).toBeNull();
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
 * The measuring window: the ~20-30s between the `done` paint and the rescore
 * landing.
 *
 * This slot used to be filled with `tailored.projected_match_score` — the
 * tailor model's estimate of its own work — in success green, with an arrow,
 * indistinguishable from a settled measurement. In production that rendered
 * "78 → 72" and then became "78 → 82" once the real number landed: an
 * unlabelled guess, ten points out in the wrong direction, telling the user
 * their rewrite made things worse. The score floor governs MEASURED numbers
 * and has no authority over a projection, so the projection had to stop
 * pretending to be one.
 *
 * The rule those tests pin: the right-hand slot shows a measurement, a pending
 * placeholder, or an explicitly-labelled estimate — never an unlabelled
 * projection.
 */
describe("Results - the measuring window", () => {
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

  const READY_HINT =
    "Your tailored resume is ready to download — we're re-measuring the match score, about 20 seconds.";
  const ESTIMATE_NOTE = "Estimated by the rewriter — we couldn't re-measure this one.";

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

  const buttons = () => Array.from(container.querySelectorAll("button")).map((b) => b.textContent);

  // (a) The bug, stated as a test. TAILORED's projection is 70; while the
  // measurement is in flight that number must not be anywhere in the score
  // slot, because nothing has measured it and it is about to be replaced.
  it("holds the slot on a placeholder — never the projection — while the measurement is in flight", async () => {
    await renderScore({ measuring: true });
    expect(container.querySelector(".score .pending-dots")?.textContent).toBe("…");
    expect(container.querySelector(".score")?.textContent).toBe("60 → … match");
    expect(container.querySelector(".score")?.textContent).not.toContain("70");
    // The document is finished and downloadable — only its score is pending —
    // so the button is there, and the hint next to it says exactly that.
    expect(buttons()).toContain("Download PDF resume");
    expect(container.textContent).toContain(READY_HINT);
  });

  // (b) The repair leg measures too, so it is inside the window — but it owns
  // the copy there. Its sentence is about a second pass over the RESUME, and
  // telling the user the resume is ready to download in the same breath would
  // point at a document that is being replaced.
  it("yields the copy to the repair leg, which is rewriting the document itself", async () => {
    await renderScore({ measuring: true, refining: true });
    expect(container.textContent).toContain(
      "Taking a second pass at your resume — this usually takes under a minute.",
    );
    expect(container.textContent).not.toContain(READY_HINT);
  });

  // (c) The measurement is over and produced nothing: the rescore leg failed,
  // or this is an entry cached before rescoring existed. The projection is all
  // there is, so it is shown — labelled, and never in the improvement colour.
  it("labels the projection as an estimate once the measurement is over and empty", async () => {
    await renderScore({ measuring: false, rescoredScore: null });
    expect(container.querySelector(".score")?.textContent).toBe("60 → 70 match");
    expect(container.querySelector(".score .after-neutral")).toBeTruthy();
    expect(container.querySelector(".score .after")).toBeNull();
    expect(container.textContent).toContain(ESTIMATE_NOTE);
    expect(container.querySelector(".score .pending-dots")).toBeNull();
  });

  // (d) The settled case, byte-identical to what it always was: green arrow,
  // no estimate label, no placeholder.
  it("leaves a measured number exactly as it was", async () => {
    await renderScore({ measuring: false, rescoredScore: 82 });
    expect(container.querySelector(".score")?.textContent).toBe("60 → 82 match");
    expect(container.querySelector(".score .after")).toBeTruthy();
    expect(container.textContent).not.toContain(ESTIMATE_NOTE);
    expect(container.textContent).not.toContain(READY_HINT);
  });

  // (e2) The rule read from the other side: a MEASURED number that has already
  // been published wins the slot, flag or no flag. run.ts lowers `measuring` at
  // the auto-refine flush precisely so the tail never runs in this state, but a
  // patch stream this component did not see in order — or a live-run record
  // written by an older build — can still produce it, and covering a real
  // measurement with "…" hides the very number the hint underneath is about.
  //
  // The placeholder means "nothing has been measured yet", which is exactly
  // `rescoredScore === null`; it was never meant to outlive the number.
  it("shows a published measurement rather than the placeholder while the flag is up", async () => {
    await renderScore({ measuring: true, rescoredScore: 82 });
    expect(container.querySelector(".score")?.textContent).toBe("60 → 82 match");
    expect(container.querySelector(".score .pending-dots")).toBeNull();
    // Measured and improved: the one case that earns the improvement colour.
    expect(container.querySelector(".score .after")).toBeTruthy();
    expect(container.textContent).not.toContain(ESTIMATE_NOTE);

    // The auto-refine tail's own state — the same number, under the hint that
    // says a better rewrite is being attempted against it. The hint is a
    // sentence about that number, so the number has to be readable.
    await renderScore({ measuring: true, refining: true, rescoredScore: 82 });
    expect(container.querySelector(".score")?.textContent).toBe("60 → 82 match");
    expect(container.querySelector(".score .pending-dots")).toBeNull();
    expect(container.textContent).toContain("Improving the rewrite against the gaps…");
  });

  // (e) A restored cache entry is a finished run read back off disk — every
  // flag down, the measurement already in it. A placeholder there would be the
  // panel claiming to be measuring something it will never measure.
  it("never animates a restored cache entry", async () => {
    await renderScore({ measuring: false, refining: false, rescoredScore: 77 });
    expect(container.querySelector(".score")?.textContent).toBe("60 → 77 match");
    expect(container.querySelector(".pending-dots")).toBeNull();
    expect(container.textContent).not.toContain(READY_HINT);
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
