import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { GapAnalysis, ParsedResume, TailorResult } from "@shared/contract";
import type { ExtractedJD } from "@/content/extract";
import type { RunOptions, RunState } from "@/lib/run";
import { getResume, setResume, type StoredResume } from "@/lib/storage";
import { countCachedRuns, getCachedRun, putCachedRun, type CachedRun } from "@/lib/cache";
import { resumeFingerprint } from "@/lib/fingerprint";
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
// Mock `@/lib/cache`'s `getCachedRun` ONLY — every other export (`putCachedRun`,
// `cacheKey`, `countCachedRuns`, `clearCachedRuns`) stays real via
// importActual, since most tests seed and read the actual faked
// chrome.storage. `getCachedRun` alone gets an override hook so ONE test
// (Finding 2, below) can hold open the JD-change effect's OWN restore call —
// the only place in App.tsx that calls it besides generate()'s post-run
// check — to reproduce a click landing before that restore resolves. Every
// other test leaves the override unset, so this call passes straight
// through to the real implementation.
// ---------------------------------------------------------------------------
type GetCachedRunFn = typeof import("@/lib/cache").getCachedRun;

let getCachedRunOverride: GetCachedRunFn | null = null;
let getCachedRunCallCount = 0;

vi.mock("@/lib/cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cache")>();
  return {
    ...actual,
    getCachedRun: (url: string, fingerprint: string) => {
      getCachedRunCallCount += 1;
      return (getCachedRunOverride ?? actual.getCachedRun)(url, fingerprint);
    },
  };
});

// ---------------------------------------------------------------------------
// Mock `@/lib/clerk` — Task 5 wires App.tsx to this module on mount. A real
// import pulls in @clerk/chrome-extension, which pulls in
// webextension-polyfill, which throws outside an actual extension runtime
// ("This script should only be loaded in a browser extension") — this jsdom
// environment fakes chrome.storage (below), not the whole extension host.
//
// `clerkState` is plain module state so a test can set signed-in/email
// BEFORE rendering; `installClerkTokenSourceCalls` and `signOutCallCount`
// are asserted on directly, since App.tsx calling the real functions is
// exactly the behavior Task 5 requires and this mock would otherwise hide.
// ---------------------------------------------------------------------------
let clerkState: { signedIn: boolean; email: string | null } = {
  signedIn: false,
  email: null,
};
let installClerkTokenSourceCalls = 0;
let signOutCallCount = 0;
// Lets one test (the sign-out-fails case) make the mocked signOut() reject,
// to pin SignOutDialog's catch and the reordering that keeps a rejection
// from ever leaving the session ended while the UI still shows signed in.
let signOutShouldThrow = false;
const SIGNIN_URL = "https://example.com/src/signin/index.html";

vi.mock("@/lib/clerk", () => ({
  installClerkTokenSource: () => {
    installClerkTokenSourceCalls += 1;
  },
  isSignedIn: async () => clerkState.signedIn,
  currentUserEmail: async () => clerkState.email,
  signOut: async () => {
    signOutCallCount += 1;
    if (signOutShouldThrow) throw new Error("network blip");
  },
  signInPageUrl: () => SIGNIN_URL,
}));

// Applies to EVERY test in this file, both describe blocks below — clerk
// state must not leak from one test into the next regardless of which
// describe registered it.
beforeEach(() => {
  clerkState = { signedIn: false, email: null };
  installClerkTokenSourceCalls = 0;
  signOutCallCount = 0;
  signOutShouldThrow = false;
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
    baselineScore: score,
    resumeFingerprint: resumeFingerprint(RESUME),
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

function hasButton(container: HTMLElement, text: string): boolean {
  return Array.from(container.querySelectorAll("button")).some(
    (b) => b.textContent?.trim() === text,
  );
}

function findAnchor(container: HTMLElement, text: string): HTMLAnchorElement {
  const a = Array.from(container.querySelectorAll("a")).find(
    (el) => el.textContent?.trim() === text,
  );
  if (!a) {
    const labels = Array.from(container.querySelectorAll("a")).map((el) =>
      el.textContent?.trim(),
    );
    throw new Error(`anchor "${text}" not found. Present: ${JSON.stringify(labels)}`);
  }
  return a;
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
    getCachedRunOverride = null;
    getCachedRunCallCount = 0;
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

  // The bug this whole plan exists for: the user generated once, added
  // experience, regenerated — and the LEFT number moved, reading as "adding
  // information made my resume worse". It was resampling, not a real change.
  //
  // The two assertions below check the WHOLE rendered string, not just the
  // left half. `toContain("70")` alone is not enough to pin the freeze: the
  // second run's right-hand (projected) number also rounds to 70 by
  // coincidence when left unfrozen, so a `toContain` check on "70" passes
  // whether or not the baseline actually held — it would even pass with
  // `roundToFive` deleted from the right-hand number entirely. The exact
  // strings below discriminate all three regressions: dropping the freeze
  // gives "60 → …", dropping left rounding gives "72 → …", dropping right
  // rounding gives "… → 88 match".
  it("keeps the baseline fixed when the same posting is regenerated", async () => {
    // First run: analyze says 72. That becomes this posting's baseline.
    // Second run: analyze says 62 — the same drift the user hit. The panel
    // must still show 70 on the left (72 rounded), not 60.
    await setResume(STORED_RESUME);
    // A has no cache entry — this is a fresh, unrefined generate.

    activeJdState = { jd: JD_A, failure: null, loading: false };
    await renderApp();

    runTailorImpl = async (_jd, _resume, onUpdate) => {
      onUpdate({
        phase: "done",
        analysis: analysisFixture(72),
        tailored: tailoredFixture(82),
        remaining: 3,
      });
    };

    await act(async () => {
      findButton(container, "Tailor my resume").click();
    });
    await flush();

    const score = () => container.querySelector(".score")?.textContent ?? "";
    expect(score()).toBe("70 → 80 match");

    // Second run, same posting: analyze drifts down to 62. The baseline must
    // not move with it. The projected score is deliberately NOT 72 here —
    // that would round to the same 70 as the frozen baseline and let this
    // assertion pass whether or not the freeze actually happened.
    runTailorImpl = async (_jd, _resume, onUpdate) => {
      onUpdate({
        phase: "done",
        analysis: analysisFixture(62),
        tailored: tailoredFixture(88),
        remaining: 2,
      });
    };

    await act(async () => {
      findButton(container, "Tailor again").click();
    });
    await flush();

    expect(score()).toBe("70 → 90 match");
  });

  // Finding 2: `baselineForPosting` (React state) is null from the moment
  // the JD-change effect fires until its OWN getCachedRun read resolves, and
  // `canRun` only needs `stored` — not a landed restore — so the button is
  // live throughout that window. A click there must not let generate()
  // re-measure and durably overwrite the baseline already sitting in
  // storage.
  it("does not let a regenerate started before the restore lands overwrite the stored baseline (Finding 2)", async () => {
    await setResume(STORED_RESUME);
    await putCachedRun(JD_A.url, cachedRun(72, "", "run-a-cached"));

    // Hold open the JD-change effect's OWN restore call — the only OTHER
    // caller of getCachedRun besides generate()'s post-run check — so
    // `baselineForPosting` is still null when the click below lands. This
    // reproduces the race without touching chrome.storage's own timing.
    let releaseRestore: (() => void) | null = null;
    const actualCache = await vi.importActual<typeof import("@/lib/cache")>("@/lib/cache");
    getCachedRunOverride = (url, fingerprint) =>
      new Promise((resolve) => {
        releaseRestore = () => resolve(actualCache.getCachedRun(url, fingerprint));
      });

    activeJdState = { jd: JD_A, failure: null, loading: false };
    await renderApp();

    // The restore call landed and is being held open — confirms the race
    // window is real, not accidentally skipped.
    expect(getCachedRunCallCount).toBe(1);
    // The supplement box is gated on `analysis`, which is still null because
    // the restore hasn't landed — the panel really is still blank.
    expect(container.querySelector("textarea.paste")).toBeNull();
    // But the button is clickable NOW. That liveness is the bug.
    expect(findButton(container, "Tailor my resume")).toBeTruthy();

    // Let generate()'s OWN getCachedRun call (the Finding 2 fix) resolve
    // normally against real storage, so the run below measures whatever the
    // fix actually reads — not another held-open promise.
    getCachedRunOverride = null;

    runTailorImpl = async (_jd, _resume, onUpdate) => {
      onUpdate({
        phase: "done",
        analysis: analysisFixture(55),
        tailored: tailoredFixture(65),
        remaining: 5,
      });
    };

    await act(async () => {
      findButton(container, "Tailor my resume").click();
    });
    await flush();

    // The regenerate must have read the baseline already in storage (72),
    // not re-measured from this run's fresh analyze score (55).
    const restored = await getCachedRun(JD_A.url, resumeFingerprint(RESUME));
    expect(restored?.baselineScore).toBe(72);

    // Let the original restore settle too, so nothing dangles into another
    // test.
    await act(async () => {
      releaseRestore?.();
    });
    await flush();
  });

  // Finding 6: every OTHER test in this file caches its entries under
  // resumeFingerprint(RESUME) — the same resume App renders with — so the
  // fingerprint mismatch branch (the `useMemo`, the `!fingerprint` guard, the
  // effect dependency, and `setBaselineForPosting(hit.baselineScore)`) has
  // never actually run in a test. This is the one that exercises it: the
  // entry is seeded under a fingerprint that cannot equal the real resume's,
  // computed the same way every other cache write in this file computes it.
  it("does not display or reuse a cached entry whose fingerprint does not match the loaded resume (Finding 6)", async () => {
    await setResume(STORED_RESUME);
    // Non-empty extraInfo matters here, not just for realism: the runId
    // assertion below is only meaningful if a wiring bug that wrongly
    // restores this entry would ALSO populate the supplement box, since
    // generate()'s free-refinement branch only reuses `runIdForPosting` when
    // the submitted supplement is non-empty. With extraInfo "", the primary
    // button would mint a fresh id either way and the assertion would pass
    // for the wrong reason.
    await putCachedRun(JD_A.url, {
      ...cachedRun(72, "experience that belongs to a different resume", "cached-run-mismatched-fp"),
      resumeFingerprint: "mismatched-fingerprint",
    });

    activeJdState = { jd: JD_A, failure: null, loading: false };
    await renderApp();

    // Display half of criterion 3 / the arrival half of criterion 5: a
    // fingerprint-mismatched entry must not be painted, so the score card
    // App.tsx renders on `analysis` must not exist.
    expect(container.querySelector(".score")).toBeNull();
    // Confirms the panel really is in the fresh, unrestored state rather
    // than partially restored.
    expect(container.querySelector("textarea.paste")).toBeNull();

    // runId half of criterion 3: regenerating from here must not reuse the
    // stale entry's run id.
    runTailorImpl = async () => {};
    const primaryButton = container.querySelector("button.primary") as HTMLButtonElement;
    expect(primaryButton).toBeTruthy();
    await act(async () => {
      primaryButton.click();
    });
    await flush();

    expect(runTailorCalls.at(-1)?.opts?.runId).not.toBe("cached-run-mismatched-fp");
  });
});

// ---------------------------------------------------------------------------
// Task 5: AccountBar, SignOutDialog, the exhausted-trial prompt, and
// session_expired — all reached through App, per this package's testing
// reality (see the task's brief). A separate describe block, with its own
// container/root, rather than folding into the block above: that one's
// beforeEach/afterEach and helper closures are scoped to its own `describe`,
// and duplicating the ~10 lines of harness here is cheaper than threading
// this suite's state through it.
// ---------------------------------------------------------------------------
describe("App - account bar, sign-out, and session handling", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("chrome", fakeChromeStorage());
    activeJdState = { jd: null, failure: null, loading: false };
    runTailorImpl = async () => {};
    runTailorCalls = [];
    getCachedRunOverride = null;
    getCachedRunCallCount = 0;
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

  // Same reasoning as the other describe block's `flush` — chrome.storage's
  // fake is itself async, and so is this suite's own clerk mock (isSignedIn/
  // currentUserEmail both resolve via a real Promise), so a state update
  // they cause can be a few microtask hops behind whatever `act` directly
  // awaited.
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

  it("calls installClerkTokenSource exactly once on mount — without it every request is a device request", async () => {
    await renderApp();
    expect(installClerkTokenSourceCalls).toBe(1);
  });

  it("shows the Sign in control with its reason when signed out, and no Sign out control", async () => {
    await renderApp();

    const link = findAnchor(container, "Sign in");
    expect(link.getAttribute("href")).toBe(SIGNIN_URL);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(container.textContent).toContain(
      "raise your limit from 3 runs every 30 days to 5 runs a day",
    );
    expect(hasButton(container, "Sign out")).toBe(false);
  });

  it("shows the account email and Sign out once signed in, and picks up the remaining count from RunState — not a separate fetch", async () => {
    clerkState = { signedIn: true, email: "ada@example.com" };
    activeJdState = { jd: JD_A, failure: null, loading: false };
    await setResume(STORED_RESUME);
    await renderApp();

    expect(container.textContent).toContain("ada@example.com");
    expect(findButton(container, "Sign out")).toBeTruthy();
    // No run has reported a `remaining` yet (RunState starts at
    // INITIAL_RUN_STATE), so there is nothing truthful to show.
    expect(container.textContent).not.toContain("left today");

    runTailorImpl = async (_jd, _resume, onUpdate) => {
      onUpdate({
        phase: "done",
        analysis: analysisFixture(70),
        tailored: tailoredFixture(80),
        remaining: 3,
      });
    };
    await act(async () => {
      findButton(container, "Tailor my resume").click();
    });
    await flush();

    // This is the number generate() got back from THIS run — AccountBar must
    // display exactly it, not a value it looked up on its own.
    expect(container.textContent).toContain("3 runs left today");
  });

  it("sign-out with the box checked (the default) ends the session AND clears the resume, the cache, and the displayed run", async () => {
    clerkState = { signedIn: true, email: "ada@example.com" };
    activeJdState = { jd: JD_A, failure: null, loading: false };
    await setResume(STORED_RESUME);
    await putCachedRun(JD_A.url, cachedRun(72, "", "run-a-cached"));
    await renderApp();

    // The cached run restores on mount — confirms there is a displayed
    // result and a resume on screen before sign-out touches anything.
    expect(container.querySelector(".score")).toBeTruthy();
    expect(container.textContent).toContain("Ada Lovelace");
    expect(findButton(container, "Clear 1 cached result")).toBeTruthy();

    await act(async () => {
      findButton(container, "Sign out").click();
    });

    const dialog = container.querySelector(".dialog") as HTMLElement;
    expect(dialog).toBeTruthy();
    const checkbox = dialog.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox.checked).toBe(true); // checked BY DEFAULT
    const label = dialog.querySelector(".dialog-checkbox") as HTMLElement;
    expect(label.textContent?.trim()).toBe(
      "Also remove my resume and saved results from this browser.",
    );

    await act(async () => {
      findButton(dialog, "Sign out").click();
    });
    await flush();

    expect(signOutCallCount).toBe(1);
    // The session ended...
    expect(findAnchor(container, "Sign in")).toBeTruthy();
    expect(hasButton(container, "Sign out")).toBe(false);
    // ...AND, because the box was checked, everything else did too: storage
    // itself (not just the display)...
    expect(await getResume()).toBeNull();
    expect(await countCachedRuns()).toBe(0);
    // ...and the panel's own displayed state, so nothing from the previous
    // session lingers on screen.
    expect(container.querySelector(".score")).toBeNull();
    expect(container.textContent).not.toContain("Ada Lovelace");
    expect(
      Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.startsWith("Clear"),
      ),
    ).toBeUndefined();
  });

  it("sign-out with the box UNCHECKED ends only the session — resume, cache, and the displayed run all survive", async () => {
    clerkState = { signedIn: true, email: "ada@example.com" };
    activeJdState = { jd: JD_A, failure: null, loading: false };
    await setResume(STORED_RESUME);
    await putCachedRun(JD_A.url, cachedRun(72, "", "run-a-cached"));
    await renderApp();

    expect(container.querySelector(".score")).toBeTruthy();

    await act(async () => {
      findButton(container, "Sign out").click();
    });
    const dialog = container.querySelector(".dialog") as HTMLElement;
    const checkbox = dialog.querySelector('input[type="checkbox"]') as HTMLInputElement;

    act(() => {
      checkbox.click(); // uncheck
    });
    expect(checkbox.checked).toBe(false);

    await act(async () => {
      findButton(dialog, "Sign out").click();
    });
    await flush();

    expect(signOutCallCount).toBe(1);
    // The session still ended...
    expect(findAnchor(container, "Sign in")).toBeTruthy();
    // ...but NOTHING local was touched: neither storage...
    expect(await getResume()).not.toBeNull();
    expect(await countCachedRuns()).toBe(1);
    // ...nor the panel's own display.
    expect(container.querySelector(".score")).toBeTruthy();
    expect(container.textContent).toContain("Ada Lovelace");
    expect(findButton(container, "Clear 1 cached result")).toBeTruthy();
  });

  it("offers sign-in when a SIGNED-OUT caller's trial is exhausted, distinct from a generic auth error", async () => {
    activeJdState = { jd: JD_A, failure: null, loading: false };
    await setResume(STORED_RESUME);
    await renderApp();

    runTailorImpl = async (_jd, _resume, onUpdate) => {
      onUpdate({
        phase: "error",
        error: { kind: "quota", message: "You've used all your free runs." },
      });
    };
    await act(async () => {
      findButton(container, "Tailor my resume").click();
    });
    await flush();

    expect(container.textContent).toContain("You've used all your free runs.");
    const cta = findAnchor(container, "Sign in for more runs");
    expect(cta.getAttribute("href")).toBe(SIGNIN_URL);

    // A generic auth failure has no such offer — nothing Clerk-shaped to
    // route back to for a caller who was never signed in in the first
    // place.
    runTailorImpl = async (_jd, _resume, onUpdate) => {
      onUpdate({ phase: "error", error: { kind: "auth", message: "Not authorized." } });
    };
    await act(async () => {
      findButton(container, "Tailor my resume").click();
    });
    await flush();

    expect(
      Array.from(container.querySelectorAll("a")).find(
        (a) => a.textContent?.trim() === "Sign in for more runs",
      ),
    ).toBeUndefined();
  });

  it("renders session_expired with its own route back to sign-in, distinct from a generic auth error", async () => {
    clerkState = { signedIn: true, email: "ada@example.com" };
    activeJdState = { jd: JD_A, failure: null, loading: false };
    await setResume(STORED_RESUME);
    await renderApp();

    runTailorImpl = async (_jd, _resume, onUpdate) => {
      onUpdate({
        phase: "error",
        error: {
          kind: "session_expired",
          message: "Your session expired. Sign in again to continue.",
        },
      });
    };
    await act(async () => {
      findButton(container, "Tailor my resume").click();
    });
    await flush();

    expect(container.textContent).toContain("Your session expired. Sign in again to continue.");
    const cta = findAnchor(container, "Sign in again");
    expect(cta.getAttribute("href")).toBe(SIGNIN_URL);

    runTailorImpl = async (_jd, _resume, onUpdate) => {
      onUpdate({ phase: "error", error: { kind: "auth", message: "Not authorized." } });
    };
    await act(async () => {
      findButton(container, "Tailor my resume").click();
    });
    await flush();

    expect(
      Array.from(container.querySelectorAll("a")).find(
        (a) => a.textContent?.trim() === "Sign in again",
      ),
    ).toBeUndefined();
  });

  // Review Critical: AccountBar's Sign out had no `busy` guard, and
  // generate()'s own guard only keys on which POSTING is active — not on
  // whether the user is still signed in. So a sign-out (box checked) mid-run
  // used to clear cp_resume/cp_results and reset the display, only for the
  // still-in-flight run to repaint the previous session's result over the
  // cleared panel and, on resolution, putCachedRun() the previous user's
  // tailored resume BACK into chrome.storage.local. This pins the fix: Sign
  // out must be inert while busy, the same way "Clear N cached results"
  // already is (see its own `disabled={busy}` a few lines up in App.tsx).
  it("disables Sign out while a run is in flight, so a mid-run sign-out cannot clear and re-persist the previous session's results", async () => {
    clerkState = { signedIn: true, email: "ada@example.com" };
    activeJdState = { jd: JD_A, failure: null, loading: false };
    await setResume(STORED_RESUME);
    await renderApp();

    let releaseRun: (() => void) | null = null;
    runTailorImpl = () =>
      new Promise((resolve) => {
        releaseRun = resolve;
      });

    await act(async () => {
      findButton(container, "Tailor my resume").click();
    });
    await flush();
    expect(findButton(container, "Working…")).toBeTruthy(); // run genuinely in flight

    const signOutBtn = findButton(container, "Sign out");
    expect(signOutBtn.disabled).toBe(true);

    // A disabled button doesn't fire onClick in the DOM, so this click is
    // itself part of the assertion: if the guard were missing, this would
    // open the dialog.
    await act(async () => {
      signOutBtn.click();
    });
    expect(container.querySelector(".dialog")).toBeNull();

    await act(async () => {
      releaseRun?.();
    });
    await flush();

    // The run settled — Sign out is live again.
    expect(findButton(container, "Sign out").disabled).toBe(false);
  });

  it("does not offer the exhausted-trial sign-in CTA to a caller who is already signed in", async () => {
    clerkState = { signedIn: true, email: "ada@example.com" };
    activeJdState = { jd: JD_A, failure: null, loading: false };
    await setResume(STORED_RESUME);
    await renderApp();

    runTailorImpl = async (_jd, _resume, onUpdate) => {
      onUpdate({
        phase: "error",
        error: { kind: "quota", message: "You've used all your free runs." },
      });
    };
    await act(async () => {
      findButton(container, "Tailor my resume").click();
    });
    await flush();

    // The generic message still renders...
    expect(container.textContent).toContain("You've used all your free runs.");
    // ...but there is nothing further to sign into: 5/day is already the
    // raised allowance this same account is on.
    expect(
      Array.from(container.querySelectorAll("a")).find(
        (a) => a.textContent?.trim() === "Sign in for more runs",
      ),
    ).toBeUndefined();
  });

  it("re-checks Clerk on visibilitychange, so a sign-in completed in the separate tab is picked up without reopening the panel", async () => {
    await renderApp();
    // Starts signed out — nothing has told the panel otherwise yet.
    expect(findAnchor(container, "Sign in")).toBeTruthy();

    // The user finished signing in in the separate tab Clerk's session now
    // reflects that; the panel itself has had no push notification of it.
    clerkState = { signedIn: true, email: "ada@example.com" };
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await flush();

    expect(container.textContent).toContain("ada@example.com");
    expect(findButton(container, "Sign out")).toBeTruthy();
  });

  // Review Important: signOut() could throw (clerk.ts documents getClerk()
  // as able to reject transiently), and the original try/finally had no
  // catch — a rejection meant onConfirmed() never ran, silently leaving the
  // dialog's "Signing out…" button revert to "Sign out" with no explanation.
  // This pins the fix in its cleanest form: box UNCHECKED, so nothing but
  // signOut() itself is at stake, and the failure must leave everything
  // exactly as it was (dialog open, session intact, nothing local touched)
  // rather than landing in an ambiguous state.
  it("surfaces a signOut() failure, keeps the dialog open for a retry, and does not desync the account bar from the still-live session", async () => {
    clerkState = { signedIn: true, email: "ada@example.com" };
    activeJdState = { jd: JD_A, failure: null, loading: false };
    await setResume(STORED_RESUME);
    await renderApp();

    await act(async () => {
      findButton(container, "Sign out").click();
    });
    const dialog = container.querySelector(".dialog") as HTMLElement;
    const checkbox = dialog.querySelector('input[type="checkbox"]') as HTMLInputElement;
    act(() => {
      checkbox.click(); // uncheck — isolates this test to signOut() alone
    });

    signOutShouldThrow = true;
    await act(async () => {
      findButton(dialog, "Sign out").click();
    });
    await flush();

    expect(signOutCallCount).toBe(1);
    // The dialog is still here, with an explanation, not silently reverted.
    expect(container.querySelector(".dialog")).toBeTruthy();
    expect(container.querySelector(".dialog")?.textContent).toContain(
      "Couldn't sign out. Try again.",
    );
    // Nothing about the session changed — the bar must not have desynced
    // into showing "Sign in" for a session that is, in fact, still live.
    expect(container.textContent).toContain("ada@example.com");
    expect(
      Array.from(container.querySelectorAll("a")).find((a) => a.textContent?.trim() === "Sign in"),
    ).toBeUndefined();
    expect(await getResume()).not.toBeNull();

    // Retry, this time letting signOut() succeed.
    signOutShouldThrow = false;
    await act(async () => {
      findButton(dialog, "Sign out").click();
    });
    await flush();

    expect(signOutCallCount).toBe(2);
    expect(container.querySelector(".dialog")).toBeNull();
    expect(findAnchor(container, "Sign in")).toBeTruthy();
  });
});
