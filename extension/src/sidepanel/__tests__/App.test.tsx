import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { GapAnalysis, ParsedResume, TailorResult } from "@shared/contract";
import type { ExtractedJD } from "@/content/extract";
import type { RunOptions, RunState } from "@/lib/run";
import { setResume, type StoredResume } from "@/lib/storage";
import { putCachedRun, type CachedRun } from "@/lib/cache";
import App from "../App";

// No @testing-library/react here (see the module doc below for why), so this
// is not set up implicitly the way its render() would. Without it React logs
// "The current testing environment is not configured to support act(...)" on
// every state update, even though act() is in fact wrapping all of them.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Regression coverage for App.tsx's cross-posting state handling.
 *
 * App.tsx has produced three cross-posting state defects across three
 * reviews (the guard around `runningForUrlRef`, the guard around the
 * completed-run display writes, and now the supplement-substitution bug this
 * file pins) — every one found by a human reading code, none by a test. This
 * file exists to change that for the supplement-substitution class of bug and
 * the two related behaviors reviewers keep having to re-verify by hand.
 *
 * No new package is needed: `extension/vite.config.ts` already runs tests
 * under jsdom, and `react-dom` (a runtime dependency) ships `createRoot` and
 * `act`. `@testing-library/react` would be convenience, not capability.
 */

// ---------------------------------------------------------------------------
// Mock `./useActiveJd` — the test drives "tab switches" by mutating
// `activeJdState` and re-rendering. Vitest resolves this relative path
// against THIS file's location, so it must point at ../useActiveJd (the same
// file App.tsx reaches via ./useActiveJd from one directory up).
// ---------------------------------------------------------------------------
let activeJdState: { jd: ExtractedJD | null; failure: null; loading: boolean } = {
  jd: null,
  failure: null,
  loading: false,
};

vi.mock("../useActiveJd", () => ({
  useActiveJd: () => ({
    jd: activeJdState.jd,
    failure: activeJdState.failure,
    loading: activeJdState.loading,
    reread: async () => {},
    setJd: () => {},
  }),
}));

// ---------------------------------------------------------------------------
// Mock `@/lib/run` — only `runTailor` is replaced, so the test controls
// exactly when a run resolves and what it reports. `newRunId` and
// `INITIAL_RUN_STATE` stay real via importActual, since App.tsx's own runId
// bookkeeping (the thing case 3 below pins) has to run against the genuine
// id generator, not a fake one.
// ---------------------------------------------------------------------------
type RunTailorFn = (
  jd: ExtractedJD,
  resume: ParsedResume,
  onUpdate: (patch: Partial<RunState>) => void,
  opts?: RunOptions,
) => Promise<void>;

let runTailorImpl: RunTailorFn = async () => {};
let runTailorCalls: Array<{ opts: RunOptions | undefined }> = [];

vi.mock("@/lib/run", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/run")>();
  return {
    ...actual,
    runTailor: (
      jd: ExtractedJD,
      resume: ParsedResume,
      onUpdate: (patch: Partial<RunState>) => void,
      opts?: RunOptions,
    ) => {
      runTailorCalls.push({ opts });
      return runTailorImpl(jd, resume, onUpdate, opts);
    },
  };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const RESUME: ParsedResume = {
  contact: { name: "Ada Lovelace", email: "", phone: "", location: "", links: [] },
  summary: "",
  experience: [],
  projects: [],
  skills: [],
  education: [],
};

const STORED_RESUME: StoredResume = {
  resume: RESUME,
  parsedAt: "2026-08-10T00:00:00.000Z",
  name: "Ada Lovelace",
};

const JD_A: ExtractedJD = {
  text: "a".repeat(400),
  title: "Backend Engineer",
  company: "Acme",
  url: "https://acme.com/jobs/1",
};

const JD_B: ExtractedJD = {
  text: "b".repeat(400),
  title: "Frontend Engineer",
  company: "Beta Corp",
  url: "https://beta.com/jobs/2",
};

function analysisFixture(score: number): GapAnalysis {
  return {
    overall_match_score: score,
    rationale: "",
    requirements_matrix: [],
    strengths: [],
    gaps: [],
  };
}

function tailoredFixture(score: number): TailorResult {
  return { resume: RESUME, change_log: [], projected_match_score: score };
}

function cachedRun(score: number, extraInfo: string, runId: string): CachedRun {
  return {
    analysis: analysisFixture(score),
    tailored: tailoredFixture(score + 10),
    generatedAt: "2026-08-14T10:00:00.000Z",
    extraInfo,
    runId,
  };
}

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

// ---------------------------------------------------------------------------
// DOM helpers — no @testing-library, just the platform.
// ---------------------------------------------------------------------------
function findButton(container: HTMLElement, text: string): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === text,
  );
  if (!btn) {
    const labels = Array.from(container.querySelectorAll("button")).map((b) =>
      b.textContent?.trim(),
    );
    throw new Error(`button "${text}" not found. Present: ${JSON.stringify(labels)}`);
  }
  return btn;
}

function typeInto(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("App - cross-posting state", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("chrome", fakeChromeStorage());
    activeJdState = { jd: null, failure: null, loading: false };
    runTailorImpl = async () => {};
    runTailorCalls = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // A full task tick, not just a microtask flush: chrome.storage.local's fake
  // is itself async, and getResume/getCachedRun each chain through it plus
  // their own wrapping async function, so a state update they cause can be a
  // few microtask hops behind the promise `act`'s callback awaited directly.
  // setTimeout(0) only fires once every already-queued microtask has drained,
  // so waiting on it is enough regardless of exactly how many hops there are.
  async function flush() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  async function renderApp() {
    await act(async () => {
      root.render(<App />);
    });
    await flush();
  }

  async function rerenderApp() {
    await act(async () => {
      root.render(<App />);
    });
    await flush();
  }

  it("keeps A's own submitted supplement when the user returns to A mid-run after visiting B (Finding 1)", async () => {
    await setResume(STORED_RESUME);
    await putCachedRun(JD_A.url, cachedRun(50, "", "run-a-cached"));
    await putCachedRun(
      JD_B.url,
      cachedRun(60, "B's own paragraph about databases", "run-b-cached"),
    );

    activeJdState = { jd: JD_A, failure: null, loading: false };
    await renderApp();

    const textarea = () => container.querySelector("textarea.paste") as HTMLTextAreaElement;
    // A's cached analysis exists, so the supplement box is already mounted.
    expect(textarea()).toBeTruthy();

    act(() => {
      typeInto(textarea(), "A's own claimed experience with Kubernetes");
    });

    // Hold the run open so a tab switch can land mid-flight, same as a real
    // ~minute-long generate would.
    let releaseRun: (() => void) | null = null;
    runTailorImpl = () =>
      new Promise((resolve) => {
        releaseRun = resolve;
      });

    await act(async () => {
      findButton(container, "Add experience and regenerate").click();
    });
    await flush();

    // Busy — the button's own label confirms the run is in flight.
    expect(findButton(container, "Regenerating…")).toBeTruthy();

    // Switch to B mid-run. B has a cached, non-empty extraInfo.
    activeJdState = { jd: JD_B, failure: null, loading: false };
    await rerenderApp();
    expect(textarea().value).toBe("B's own paragraph about databases");

    // Switch back to A while the run is STILL in flight.
    activeJdState = { jd: JD_A, failure: null, loading: false };
    await rerenderApp();

    // The box under A must show what A was submitted with, not B's text.
    expect(textarea().value).toBe("A's own claimed experience with Kubernetes");

    await act(async () => {
      releaseRun?.();
    });
    await flush();
  });

  it("does not let a run completing for A overwrite B's displayed marker and run id (Finding 4's guard, pinned)", async () => {
    await setResume(STORED_RESUME);
    await putCachedRun(JD_B.url, cachedRun(60, "B's own paragraph", "run-b-original"));
    // A has no cache entry — this is a fresh, unrefined generate.

    activeJdState = { jd: JD_A, failure: null, loading: false };
    await renderApp();

    let releaseRun: ((patch: Partial<RunState>) => void) | null = null;
    runTailorImpl = (_jd, _resume, onUpdate) =>
      new Promise((resolve) => {
        releaseRun = (patch) => {
          onUpdate(patch);
          resolve();
        };
      });

    await act(async () => {
      findButton(container, "Tailor my resume").click();
    });
    await flush();
    expect(findButton(container, "Working…")).toBeTruthy();

    // Switch to B mid-run; B's cache restores over the display.
    activeJdState = { jd: JD_B, failure: null, loading: false };
    await rerenderApp();

    const score = () => container.querySelector(".score")?.textContent ?? "";
    expect(score()).toContain("60");

    // A's run finishes now, while the user is still looking at B.
    await act(async () => {
      releaseRun?.({
        phase: "done",
        analysis: analysisFixture(99),
        tailored: tailoredFixture(109),
        remaining: 2,
      });
    });
    await flush();

    // B's score and marker must be untouched by A's completion.
    expect(score()).toContain("60");
    expect(container.textContent).toContain(
      "Includes experience you added that isn’t on your resume.",
    );

    // And B's runId specifically: refine B now, with no further tab switch,
    // and confirm the id reused is B's ORIGINAL one, not something A's
    // background completion could have stamped over it with.
    runTailorImpl = async () => {};
    await act(async () => {
      findButton(container, "Add experience and regenerate").click();
    });
    await flush();
    expect(runTailorCalls.at(-1)?.opts?.runId).toBe("run-b-original");
  });

  it("reuses the cached runId on a refine, and mints a fresh one once the supplement is cleared (free vs charged)", async () => {
    await setResume(STORED_RESUME);
    await putCachedRun(JD_A.url, cachedRun(55, "prior text", "cached-run-id"));

    activeJdState = { jd: JD_A, failure: null, loading: false };
    await renderApp();

    runTailorImpl = async (_jd, _resume, onUpdate) => {
      onUpdate({
        phase: "done",
        analysis: analysisFixture(70),
        tailored: tailoredFixture(80),
        remaining: 3,
      });
    };

    const textarea = () => container.querySelector("textarea.paste") as HTMLTextAreaElement;
    expect(textarea().value).toBe("prior text");

    await act(async () => {
      findButton(container, "Add experience and regenerate").click();
    });
    await flush();

    expect(runTailorCalls.at(-1)?.opts?.runId).toBe("cached-run-id");

    // Clear the box, then use the PRIMARY button — a plain "run again" with
    // no supplement, which must be charged rather than riding the free
    // refinement window.
    act(() => {
      typeInto(textarea(), "");
    });
    await act(async () => {
      findButton(container, "Tailor again").click();
    });
    await flush();

    const secondRunId = runTailorCalls.at(-1)?.opts?.runId;
    expect(secondRunId).toBeTruthy();
    expect(secondRunId).not.toBe("cached-run-id");
  });
});
