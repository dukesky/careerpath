import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { GapAnalysis, ParsedResume, TailorResult } from "@shared/contract";
import type { ExtractedJD } from "@/content/extract";
import type { RunOptions, RunState } from "@/lib/run";
import type { ApiResult } from "@/lib/api";
import {
  getHasSignedIn,
  getResume,
  setHasSignedIn,
  setResume,
  type StoredResume,
} from "@/lib/storage";
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

// ---------------------------------------------------------------------------
// Mock `@/lib/api`'s `apiPost` — Task 6's Save control (SaveButton.tsx) calls
// it directly rather than through a `run.ts`-style wrapper, so this is the
// same "replace the network-call boundary" pattern the `@/lib/run` mock
// above uses for generate(). `apiPostForm` and everything else stay real via
// importOriginal, since nothing under test calls them.
// ---------------------------------------------------------------------------
type ApiPostFn = (path: string, body: unknown) => Promise<ApiResult<unknown>>;

let apiPostImpl: ApiPostFn = async () => ({ ok: true, data: {} });
let apiPostCalls: Array<{ path: string; body: unknown }> = [];

// `apiGet` backs Task 2's quota fetch (App.tsx's `refreshQuota`, via
// `@/lib/quota`'s `fetchQuota`). Same "replace the network-call boundary"
// pattern as `apiPost` just above, sharing this one mock factory rather than
// a second `vi.mock("@/lib/api", ...)` call, which vitest does not merge.
let apiGetImpl: (path: string) => Promise<ApiResult<unknown>> = async () => ({
  ok: true,
  data: { remaining: 3 },
});
let apiGetPaths: string[] = [];

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    apiPost: <T,>(path: string, body: unknown) => {
      apiPostCalls.push({ path, body });
      return apiPostImpl(path, body) as Promise<ApiResult<T>>;
    },
    apiGet: <T,>(path: string) => {
      apiGetPaths.push(path);
      return apiGetImpl(path) as Promise<ApiResult<T>>;
    },
  };
});

// Applies to EVERY test in this file, both describe blocks below — clerk
// state must not leak from one test into the next regardless of which
// describe registered it.
beforeEach(() => {
  clerkState = { signedIn: false, email: null };
  installClerkTokenSourceCalls = 0;
  signOutCallCount = 0;
  signOutShouldThrow = false;
  apiPostImpl = async () => ({ ok: true, data: {} });
  apiPostCalls = [];
  apiGetImpl = async () => ({ ok: true, data: { remaining: 3 } });
  apiGetPaths = [];
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
    // Task 2: the old sentence ("Sign in to raise your limit from 3 runs
    // every 30 days to 5 runs a day.") led with the OLD tier as if the
    // caller needed reminding what they were missing. This one just states
    // what signing in gets them.
    expect(container.textContent).toContain("Sign in for 5 runs a day.");
    expect(hasButton(container, "Sign out")).toBe(false);
  });

  // Task 2 replaced "not a separate fetch" (App.tsx's old behavior) with a
  // quota fetched at open — see the "App - quota-first account bar" describe
  // block for that fetch's own coverage. This test's remaining job is the
  // part that is still true post-Task-2: a completed run's own count
  // overrides whatever the quota fetch showed, rather than the two racing.
  it("shows the account email and Sign out once signed in; the run's own remaining count overrides the quota fetched at open", async () => {
    apiGetImpl = async () => ({ ok: true, data: { remaining: 9 } });
    clerkState = { signedIn: true, email: "ada@example.com" };
    activeJdState = { jd: JD_A, failure: null, loading: false };
    await setResume(STORED_RESUME);
    await renderApp();

    expect(container.textContent).toContain("ada@example.com");
    expect(findButton(container, "Sign out")).toBeTruthy();
    // No run has reported a `remaining` yet (RunState starts at
    // INITIAL_RUN_STATE), so the quota fetched at open is what's shown.
    expect(container.textContent).toContain("9 runs left today");

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
    // display exactly it, overriding the value fetched at open.
    expect(container.textContent).toContain("3 runs left today");
    expect(container.textContent).not.toContain("9 runs left today");
  });

  it("sign-out with the box checked (the default) ends the session AND clears the resume, the cache, and the displayed run", async () => {
    clerkState = { signedIn: true, email: "ada@example.com" };
    activeJdState = { jd: JD_A, failure: null, loading: false };
    await setResume(STORED_RESUME);
    await putCachedRun(JD_A.url, cachedRun(72, "", "run-a-cached"));
    // Signing in set this (lib/clerk.ts does it; @/lib/clerk is mocked here,
    // so seed it directly). Signing out must clear it — see the assertion at
    // the end of this test and its twin in the box-UNCHECKED case below.
    await setHasSignedIn();
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
    // ...including the has-signed-in hint, which lib/clerk.ts consults when
    // Clerk is unreachable. See the box-UNCHECKED twin below for why this is
    // cleared regardless of the checkbox.
    expect(await getHasSignedIn()).toBe(false);
  });

  it("sign-out with the box UNCHECKED ends only the session — resume, cache, and the displayed run all survive", async () => {
    clerkState = { signedIn: true, email: "ada@example.com" };
    activeJdState = { jd: JD_A, failure: null, loading: false };
    await setResume(STORED_RESUME);
    await putCachedRun(JD_A.url, cachedRun(72, "", "run-a-cached"));
    await setHasSignedIn();
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
    // The ONE thing that is cleared regardless of the checkbox. It is not
    // user data — it is only the hint lib/clerk.ts consults when Clerk is
    // unreachable ("is there a session here worth protecting?"), and once
    // signOut() has resolved the answer is no. Left set, a later Clerk
    // outage would refuse this browser's requests outright in defence of a
    // session that no longer exists, turning sign-out into a way to lose
    // anonymous use.
    expect(await getHasSignedIn()).toBe(false);
  });

  // FINAL-REVIEW (M1), updated for Task 2. `remaining` is per-identity: with
  // the box UNCHECKED, handleLocalDataCleared never runs, so nothing but
  // `refreshQuota` resets what AccountBar shows. Before Task 2 there was no
  // quota fetch at all, so the fix was to show no count; Task 2 adds a real
  // fetch for the NEW (signed-out) identity, so the fix now is that the
  // number on screen changes to that fetch's own answer — never the previous
  // account's daily figure re-rendered under 30-day-tier wording, which is
  // the same bug this test has pinned since fix round 1, just arriving
  // through the new fallback path this time (see the "quota-first account
  // bar" describe block's own regression guard for the box-CHECKED path).
  it("shows the freshly fetched device-trial count on sign-out, not the previous account's daily figure", async () => {
    clerkState = { signedIn: true, email: "ada@example.com" };
    activeJdState = { jd: JD_A, failure: null, loading: false };
    await setResume(STORED_RESUME);
    await renderApp();

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

    // The account's own daily allowance, on screen under signed-in wording.
    expect(container.textContent).toContain("3 runs left today");

    // The signed-out identity's own allowance — deliberately a DIFFERENT
    // number from the "3" above, so a passing assertion below cannot be a
    // coincidence of the two identities sharing a count.
    apiGetImpl = async () => ({ ok: true, data: { remaining: 1 } });

    await act(async () => {
      findButton(container, "Sign out").click();
    });
    const dialog = container.querySelector(".dialog") as HTMLElement;
    const checkbox = dialog.querySelector('input[type="checkbox"]') as HTMLInputElement;
    act(() => {
      checkbox.click(); // UNCHECKED — the case where nothing else resets state
    });
    await act(async () => {
      findButton(dialog, "Sign out").click();
    });
    await flush();

    expect(findAnchor(container, "Sign in")).toBeTruthy();
    // Not the previous account's daily figure, re-rendered under 30-day-tier
    // wording...
    expect(container.textContent).not.toContain("3 runs left");
    // ...but the signed-out identity's own freshly fetched allowance.
    expect(container.textContent).toContain("1 run left");
    // ...while the run itself is untouched, which is the whole point of
    // leaving the box unchecked.
    expect(container.querySelector(".score")).toBeTruthy();
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

  // Fix round 2, Finding 1 (IMPORTANT — introduced by fix round 1's own
  // diff): the previous fix bundled "local data cleared" and "session
  // ended" behind a single onConfirmed() call fired only after BOTH
  // clearResume()/clearCachedRuns() AND signOut() had resolved. That meant a
  // signOut()-specific failure — clearing succeeds, signOut() then rejects —
  // left onConfirmed() never called at all: chrome.storage.local was
  // genuinely emptied, but the panel kept showing the previous session's
  // resume, cache count, and run result as if nothing had happened, while an
  // error message claimed sign-out simply failed. That's data loss hidden
  // behind stale UI. This test pins the box-CHECKED case specifically (the
  // one the old bundling broke) and asserts the two signals are now
  // reported independently: local state resets the instant clearing
  // succeeds, regardless of what signOut() does next.
  it("with the box checked, a signOut() failure still reports the local clear immediately — the display resets even though the dialog stays open and the session is still live", async () => {
    clerkState = { signedIn: true, email: "ada@example.com" };
    activeJdState = { jd: JD_A, failure: null, loading: false };
    await setResume(STORED_RESUME);
    await putCachedRun(JD_A.url, cachedRun(72, "", "run-a-cached"));
    await renderApp();

    // A displayed result and a resume are on screen before sign-out touches
    // anything, same starting point as the box-checked success trace.
    expect(container.querySelector(".score")).toBeTruthy();
    expect(container.textContent).toContain("Ada Lovelace");
    expect(findButton(container, "Clear 1 cached result")).toBeTruthy();

    await act(async () => {
      findButton(container, "Sign out").click();
    });
    const dialog = container.querySelector(".dialog") as HTMLElement;
    const checkbox = dialog.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox.checked).toBe(true); // left checked — the scenario under test

    signOutShouldThrow = true;
    await act(async () => {
      findButton(dialog, "Sign out").click();
    });
    await flush();

    expect(signOutCallCount).toBe(1);
    // The dialog stays open with an explanation...
    expect(container.querySelector(".dialog")).toBeTruthy();
    expect(container.querySelector(".dialog")?.textContent).toContain(
      "Couldn't sign out. Try again.",
    );
    // ...the session genuinely didn't end, so the bar must still say so...
    expect(container.textContent).toContain("ada@example.com");
    expect(
      Array.from(container.querySelectorAll("a")).find((a) => a.textContent?.trim() === "Sign in"),
    ).toBeUndefined();
    // ...but local data really was cleared (clearResume()/clearCachedRuns()
    // ran and succeeded before signOut() was even attempted), so storage...
    expect(await getResume()).toBeNull();
    expect(await countCachedRuns()).toBe(0);
    // ...AND the panel's own display must match — it must NOT keep showing
    // a resume/result/cache count that storage no longer has.
    expect(container.querySelector(".score")).toBeNull();
    expect(container.textContent).not.toContain("Ada Lovelace");
    expect(
      Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.startsWith("Clear"),
      ),
    ).toBeUndefined();

    // Retry, letting signOut() succeed this time — confirms the recovery
    // path still works and doesn't re-clear anything that matters (the
    // second clearResume()/clearCachedRuns() pass is idempotent).
    signOutShouldThrow = false;
    await act(async () => {
      findButton(dialog, "Sign out").click();
    });
    await flush();

    expect(signOutCallCount).toBe(2);
    expect(container.querySelector(".dialog")).toBeNull();
    expect(findAnchor(container, "Sign in")).toBeTruthy();
  });

  // Fix round 2, Finding 2 (Minor — introduced by fix round 1's own diff):
  // fix round 1 deleted App.tsx's old "{state.remaining} free runs left"
  // paragraph entirely (it contradicted AccountBar's own signed-in line),
  // but that deletion removed the ONLY remaining-runs indicator signed-OUT
  // users had — AccountBar's signed-out branch never rendered `remaining`
  // at all. This pins the replacement: a known `remaining` shows in the
  // signed-out branch too, worded without "today" since the signed-out
  // device tier is 3 runs per 30 days, not a daily allowance.
  //
  // Updated for Task 2: before a run, App.tsx now has a quota fetched at
  // open to show (see the "quota-first account bar" describe block for that
  // fetch's own coverage) — this test's remaining job is confirming a
  // completed run's own count still overrides it, worded without "today".
  it("shows the remaining-runs count in the signed-out AccountBar once a run has reported one, without implying it's a daily allowance", async () => {
    apiGetImpl = async () => ({ ok: true, data: { remaining: 9 } });
    activeJdState = { jd: JD_A, failure: null, loading: false };
    await setResume(STORED_RESUME);
    await renderApp();

    // The quota fetched at open, worded without "today".
    expect(container.textContent).toContain("9 runs left");
    expect(container.textContent).not.toContain("left today");

    runTailorImpl = async (_jd, _resume, onUpdate) => {
      onUpdate({
        phase: "done",
        analysis: analysisFixture(70),
        tailored: tailoredFixture(80),
        remaining: 2,
      });
    };
    await act(async () => {
      findButton(container, "Tailor my resume").click();
    });
    await flush();

    // The run's own count overrides the quota fetched at open.
    expect(container.textContent).toContain("2 runs left");
    expect(container.textContent).not.toContain("9 runs left");
    // Not the signed-in branch's wording — the signed-out tier is a 30-day
    // window, not a daily one.
    expect(container.textContent).not.toContain("left today");
  });
});

// ---------------------------------------------------------------------------
// Task 6: the Save control (SaveButton.tsx), reached through App/Results —
// same reasoning as the account-bar describe block above for why this is a
// separate describe with its own container/root rather than folding into an
// existing block.
// ---------------------------------------------------------------------------
describe("App - saving a tailored resume from the panel", () => {
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

  // Produces a completed, tailored result on screen — the precondition for
  // Save to exist at all (it lives inside the `tailored &&` block beside
  // DownloadPdf).
  async function completeATailoredRun() {
    await setResume(STORED_RESUME);
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
    await act(async () => {
      findButton(container, "Tailor my resume").click();
    });
    await flush();
  }

  it("does not render Save when signed out, even with a completed tailored result", async () => {
    clerkState = { signedIn: false, email: null };
    await completeATailoredRun();

    // The result really did render — Download PDF proves it — so the
    // absence of Save below is the signed-out gate, not a missing result.
    expect(findButton(container, "Download PDF resume")).toBeTruthy();
    expect(hasButton(container, "Save to career-path")).toBe(false);
  });

  it("renders Save when signed in with a completed tailored result, and posts the exact body shape to /api/saved", async () => {
    clerkState = { signedIn: true, email: "ada@example.com" };
    await completeATailoredRun();

    const saveButton = findButton(container, "Save to career-path");
    expect(saveButton).toBeTruthy();
    expect(saveButton.disabled).toBe(false);

    await act(async () => {
      saveButton.click();
    });
    await flush();

    expect(apiPostCalls).toHaveLength(1);
    expect(apiPostCalls[0].path).toBe("/api/saved");
    // Field names matched exactly against src/app/api/saved/route.ts's POST
    // handler: company, roleTitle, resume, jdSummary, jdUrl.
    expect(apiPostCalls[0].body).toEqual({
      company: JD_A.company,
      roleTitle: JD_A.title,
      resume: RESUME,
      jdSummary: JD_A.text,
      jdUrl: JD_A.url,
    });
  });

  it("moves from saving to saved once the request resolves", async () => {
    clerkState = { signedIn: true, email: "ada@example.com" };
    await completeATailoredRun();

    let releaseSave: ((result: ApiResult<unknown>) => void) | null = null;
    apiPostImpl = () =>
      new Promise((resolve) => {
        releaseSave = resolve;
      });

    await act(async () => {
      findButton(container, "Save to career-path").click();
    });
    await flush();

    const savingButton = findButton(container, "Saving…");
    expect(savingButton.disabled).toBe(true);

    await act(async () => {
      releaseSave?.({ ok: true, data: { saved: {} } });
    });
    await flush();

    expect(findButton(container, "Saved ✓")).toBeTruthy();
    expect(hasButton(container, "Saving…")).toBe(false);
  });

  it("shows why a save failed and stays retryable, not stuck", async () => {
    clerkState = { signedIn: true, email: "ada@example.com" };
    await completeATailoredRun();

    apiPostImpl = async () => ({
      ok: false,
      kind: "server",
      message: "Something went wrong. Please try again.",
    });

    await act(async () => {
      findButton(container, "Save to career-path").click();
    });
    await flush();

    expect(container.textContent).toContain("Something went wrong. Please try again.");
    // Retryable, not stuck: the button is back to its idle label and enabled.
    const retryButton = findButton(container, "Save to career-path");
    expect(retryButton.disabled).toBe(false);

    // Retry, this time succeeding.
    apiPostImpl = async () => ({ ok: true, data: { saved: {} } });
    await act(async () => {
      retryButton.click();
    });
    await flush();

    expect(findButton(container, "Saved ✓")).toBeTruthy();
    expect(container.textContent).not.toContain("Something went wrong. Please try again.");
  });

  it("routes a session_expired save result to the sign-in-again CTA", async () => {
    clerkState = { signedIn: true, email: "ada@example.com" };
    await completeATailoredRun();

    apiPostImpl = async () => ({
      ok: false,
      kind: "session_expired",
      message: "Your session expired. Sign in again to continue.",
    });

    await act(async () => {
      findButton(container, "Save to career-path").click();
    });
    await flush();

    expect(container.textContent).toContain("Sign in to pick up where you left off.");
    const cta = findAnchor(container, "Sign in again");
    expect(cta.getAttribute("href")).toBe(SIGNIN_URL);
    expect(cta.getAttribute("target")).toBe("_blank");
  });

  // Fix round 1 (Important finding): SaveButton is keyed on `generatedAt` in
  // Results.tsx, so a regenerate that completes while a save is still in
  // flight would remount it — unmounting the component the pending
  // apiPost's `.then` was about to update, so its eventual result (saved or
  // failed) lands as a silent no-op and the user never finds out what
  // happened to their save. The fix disables both regenerate triggers for
  // the duration of a save (App.tsx's `canRun` folds in the new `saving`
  // state) rather than trying to make the clobbered result recoverable.
  // This test pins the guard, not the original race — the race is now
  // structurally unreachable, since regenerate cannot even start while a
  // save is pending.
  it("disables both regenerate triggers while a save is in flight, and re-enables them once it settles", async () => {
    clerkState = { signedIn: true, email: "ada@example.com" };
    await completeATailoredRun();

    // Give the supplement's own regenerate trigger something to be enabled
    // ABOUT — its own guard also requires non-empty text, so this isolates
    // the assertion to the `canRun`/`saving` guard under test rather than
    // failing on the pre-existing empty-text guard instead.
    const textarea = () => container.querySelector("textarea.paste") as HTMLTextAreaElement;
    act(() => {
      typeInto(textarea(), "Some experience I forgot to mention");
    });

    // Both triggers are live before any save starts.
    expect(findButton(container, "Tailor again").disabled).toBe(false);
    expect(findButton(container, "Add experience and regenerate").disabled).toBe(false);

    let releaseSave: ((result: ApiResult<unknown>) => void) | null = null;
    apiPostImpl = () =>
      new Promise((resolve) => {
        releaseSave = resolve;
      });

    await act(async () => {
      findButton(container, "Save to career-path").click();
    });
    await flush();

    // The save is genuinely in flight — its own button says so.
    expect(findButton(container, "Saving…")).toBeTruthy();
    // Both regenerate triggers are now blocked, closing the race.
    expect(findButton(container, "Tailor again").disabled).toBe(true);
    expect(findButton(container, "Add experience and regenerate").disabled).toBe(true);

    await act(async () => {
      releaseSave?.({ ok: true, data: { saved: {} } });
    });
    await flush();

    expect(findButton(container, "Saved ✓")).toBeTruthy();
    // Settled — both triggers are live again.
    expect(findButton(container, "Tailor again").disabled).toBe(false);
    expect(findButton(container, "Add experience and regenerate").disabled).toBe(false);
  });

  // Stalls a save and hands back the resolver, so each test below can hold
  // the POST open for exactly as long as it needs. Every one of them turns
  // on the same thing: what else in the panel can unmount SaveButton while
  // its own request is still on the wire.
  async function startStalledSave(
    container: HTMLElement,
    act_: typeof act,
  ): Promise<(result: ApiResult<unknown>) => void> {
    let release: ((result: ApiResult<unknown>) => void) | null = null;
    apiPostImpl = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    await act_(async () => {
      findButton(container, "Save to career-path").click();
    });
    if (!release) throw new Error("the save did not start");
    return release;
  }

  // FINAL-REVIEW: the FOURTH door into the lost-feedback race, and the worst
  // of them. Sign-out unmounts SaveButton through BOTH of Results.tsx's
  // gates at once — `tailored &&` (reset by onLocalDataCleared) and
  // `signedIn ||` (reset by onSignedOut). Unlike the regenerate case, the
  // POST is still on the wire carrying a still-VALID token, so it can land
  // in the account the user just asked to leave, with nothing on screen ever
  // saying so. `busy` alone did not cover this: no run is in flight during a
  // save.
  it("disables Sign out while a save is in flight, so a mid-save sign-out cannot land a save in the account being left", async () => {
    clerkState = { signedIn: true, email: "ada@example.com" };
    await completeATailoredRun();

    expect(findButton(container, "Sign out").disabled).toBe(false);

    const releaseSave = await startStalledSave(container, act);
    await flush();
    expect(findButton(container, "Saving…")).toBeTruthy(); // genuinely in flight

    const signOutBtn = findButton(container, "Sign out");
    expect(signOutBtn.disabled).toBe(true);
    // A disabled button fires no onClick, so the click is itself part of the
    // assertion: without the guard this would open the dialog.
    await act(async () => {
      signOutBtn.click();
    });
    expect(container.querySelector(".dialog")).toBeNull();

    await act(async () => {
      releaseSave({ ok: true, data: { saved: {} } });
    });
    await flush();

    expect(findButton(container, "Saved ✓")).toBeTruthy();
    expect(findButton(container, "Sign out").disabled).toBe(false);
  });

  // The third door, same shape: "Clear N cached results" nulls `tailored`,
  // which unmounts SaveButton through Results.tsx's `tailored &&` gate. It
  // had `disabled={busy}` only, and a save is not a run.
  it("disables Clear cached results while a save is in flight, so it cannot unmount the Save control mid-request", async () => {
    clerkState = { signedIn: true, email: "ada@example.com" };
    await completeATailoredRun();

    // The completed run wrote a cache entry, so the control exists at all.
    expect(findButton(container, "Clear 1 cached result").disabled).toBe(false);

    const releaseSave = await startStalledSave(container, act);
    await flush();
    expect(findButton(container, "Saving…")).toBeTruthy();

    const clearBtn = findButton(container, "Clear 1 cached result");
    expect(clearBtn.disabled).toBe(true);
    await act(async () => {
      clearBtn.click();
    });
    // Still there — the click did nothing, so the result (and with it the
    // Save control) survived.
    expect(findButton(container, "Saving…")).toBeTruthy();

    await act(async () => {
      releaseSave({ ok: true, data: { saved: {} } });
    });
    await flush();
    expect(findButton(container, "Saved ✓")).toBeTruthy();
  });

  // The one door that CANNOT be closed by disabling a control: App re-checks
  // Clerk on every visibilitychange, so `signedIn` can flip to false at any
  // moment — the session having ended in another tab — with a save already
  // on the wire. Results.tsx's Save gate is therefore `signedIn || saving`,
  // not `signedIn`: the in-flight instance has to outlive the flip and
  // receive its own response, rather than being unmounted out from under a
  // pending request.
  it("keeps an in-flight Save mounted when the session is discovered to have ended mid-request", async () => {
    clerkState = { signedIn: true, email: "ada@example.com" };
    await completeATailoredRun();

    const releaseSave = await startStalledSave(container, act);
    await flush();
    expect(findButton(container, "Saving…")).toBeTruthy();

    // The session ended somewhere else; the panel finds out the only way it
    // can, on regaining visibility.
    clerkState = { signedIn: false, email: null };
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await flush();

    // The flip really did land — the account bar is signed out now...
    expect(findAnchor(container, "Sign in")).toBeTruthy();
    expect(hasButton(container, "Sign out")).toBe(false);
    // ...and yet the save the user is waiting on is still here, still its
    // own instance, still awaiting its own response. Without `|| saving`
    // this button is gone at this exact point and the pending apiPost
    // resolves into a component that no longer exists.
    expect(findButton(container, "Saving…")).toBeTruthy();

    await act(async () => {
      releaseSave({ ok: true, data: { saved: {} } });
    });
    await flush();

    // Once the request settles, `saving` goes false and the genuinely
    // signed-out state unmounts the control on the next render — which is
    // correct, and is also the limit of what this gate can do: the outcome
    // is delivered to a live component rather than a dead one, but a user
    // whose session ended mid-save still does not get to READ it. Closing
    // that last gap would mean lifting SaveButton's status into App so the
    // panel could keep reporting it after the control is gone. Pinned as-is
    // so the behaviour is a decision rather than a surprise.
    expect(hasButton(container, "Saving…")).toBe(false);
    expect(hasButton(container, "Saved ✓")).toBe(false);
  });

  // FINAL-REVIEW (M5): "Saved ✓" was still a live button. /api/saved appends
  // rather than upserting, so a second click created a duplicate saved
  // version of a result the user had already saved — and the label gave no
  // hint that clicking again would do anything at all.
  it("stops accepting clicks once the save has succeeded, so a second click cannot create a duplicate saved version", async () => {
    clerkState = { signedIn: true, email: "ada@example.com" };
    await completeATailoredRun();

    await act(async () => {
      findButton(container, "Save to career-path").click();
    });
    await flush();

    const saved = findButton(container, "Saved ✓");
    expect(saved.disabled).toBe(true);
    expect(apiPostCalls).toHaveLength(1);

    // Disabled buttons fire no onClick, so this click is the assertion: with
    // the guard missing it would POST a second time.
    await act(async () => {
      saved.click();
    });
    await flush();
    expect(apiPostCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Task 2: the account bar leads with the caller's real allowance (GET
// /api/quota), rather than opening on a sign-in pitch that implies the
// extension gates its core function on having an account. Own describe
// block, own container/root, for the same reason the other top-level blocks
// each have one — no shared mutable DOM state between suites.
// ---------------------------------------------------------------------------
describe("App - quota-first account bar", () => {
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

  it("shows the caller's real remaining count on open, before any run", async () => {
    apiGetImpl = async () => ({ ok: true, data: { remaining: 3 } });
    await renderApp();

    expect(apiGetPaths).toContain("/api/quota");
    expect(container.textContent).toContain("3 runs left");
  });

  // The single line most responsible for the panel reading as a gate.
  it("never labels the signed-out state 'Not signed in'", async () => {
    await renderApp();

    expect(container.textContent).not.toContain("Not signed in");
    expect(findAnchor(container, "Sign in")).toBeTruthy();
  });

  it("invents no number when the quota cannot be determined", async () => {
    apiGetImpl = async () => ({ ok: false, kind: "network", message: "nope" });
    await renderApp();

    expect(container.textContent).not.toContain("runs left");
    expect(container.textContent).toContain("Sign in for 5 runs a day.");
  });

  it("shows Beta · unlimited instead of a number when a beta code is in force", async () => {
    apiGetImpl = async () => ({ ok: true, data: { remaining: null, unlimited: true } });
    await renderApp();

    expect(container.textContent).toContain("Beta · unlimited");
    expect(container.textContent).not.toContain("runs left");
  });

  // A completed run's count is fresher than the one fetched at open.
  it("prefers the count a completed run reported over the one fetched at open", async () => {
    apiGetImpl = async () => ({ ok: true, data: { remaining: 3 } });
    clerkState = { signedIn: true, email: "ada@example.com" };
    activeJdState = { jd: JD_A, failure: null, loading: false };
    await setResume(STORED_RESUME);
    await renderApp();

    runTailorImpl = async (_jd, _resume, onUpdate) => {
      onUpdate({
        phase: "done",
        analysis: analysisFixture(70),
        tailored: tailoredFixture(80),
        remaining: 1,
      });
    };
    await act(async () => {
      findButton(container, "Tailor my resume").click();
    });
    await flush();

    expect(container.textContent).toContain("1 run left today");
    expect(container.textContent).not.toContain("3 runs left");
  });

  // THE REGRESSION GUARD. Signing out switches quota buckets (5/day ->
  // 3-per-30-days). Without a refetch the panel falls back to the quota
  // fetched for the PREVIOUS identity and shows that account's leftovers
  // under signed-out wording — the exact bug the last review round fixed,
  // arriving through the new fallback path.
  it("does not show the previous account's allowance after signing out", async () => {
    apiGetImpl = async () => ({ ok: true, data: { remaining: 5 } });
    clerkState = { signedIn: true, email: "ada@example.com" };
    await setResume(STORED_RESUME);
    await renderApp();
    expect(container.textContent).toContain("5 runs left today");

    // The signed-out identity has a different allowance.
    apiGetImpl = async () => ({ ok: true, data: { remaining: 2 } });

    await act(async () => {
      findButton(container, "Sign out").click();
    });
    const dialog = container.querySelector(".dialog") as HTMLElement;
    await act(async () => {
      findButton(dialog, "Sign out").click();
    });
    await flush();

    expect(container.textContent).not.toContain("5 runs left");
    expect(container.textContent).toContain("2 runs left");
  });

  // THE REGRESSION GUARD, other direction. Sign-in happens in a separate tab
  // (see AccountBar), and the panel's visibilitychange effect is how it
  // notices the user came back and re-checks identity — but noticing the
  // identity changed without also refreshing the quota leaves the OLD
  // (signed-out, 3-per-30-days) figure on screen under the NEW (signed-in,
  // 5-per-day) wording. Different numbers for the two identities, same as
  // the sign-out guard above, so this cannot pass on a coincidence.
  it("does not show the device tier's allowance after signing in", async () => {
    apiGetImpl = async () => ({ ok: true, data: { remaining: 3 } });
    await renderApp();
    expect(container.textContent).toContain("3 runs left");

    // The user signed in, in the separate tab, and has come back. The
    // signed-in identity has a different allowance.
    clerkState = { signedIn: true, email: "ada@example.com" };
    apiGetImpl = async () => ({ ok: true, data: { remaining: 5 } });

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await flush();

    expect(container.textContent).not.toContain("3 runs left");
    expect(container.textContent).toContain("5 runs left today");
  });
});
