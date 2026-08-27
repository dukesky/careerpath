# Background Runs and Per-Tab Panel Instances Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move a generation run out of the side panel and into the background service worker, so closing the panel, switching tabs, or navigating away no longer kills it — and so up to five postings can generate at once.

**Architecture:** The service worker owns runs, keyed by normalized posting URL (the same key `cache.ts` already uses). Live run state lives in `chrome.storage.local` rather than in a message channel, because the panel can be destroyed at any moment and storage survives it — a freshly opened panel reads current state with no handshake. The panel becomes a pure view: it sends a "start" message and renders whatever storage says about the posting it is currently looking at.

**Tech Stack:** TypeScript, React 19, Chrome MV3 (`chrome.storage`, `chrome.runtime`, `chrome.sidePanel`), Vitest + jsdom.

## Global Constraints

- **Work in this worktree only:** `/Users/tianzhang/Projects/careerpath/.claude/worktrees/ext-access`, branch `feat/extension-page-access`. Never use `git stash` in any form — the stash stack is shared with other checkouts and sessions.
- **The server is not modified by this plan.** Every requirement is satisfied by existing endpoints. If a task seems to need a server change, stop and report — an assumption is wrong.
- **`extension/src/lib/run.ts` is NOT modified.** Its logic is reused verbatim; only the caller changes. It is one of the most-reviewed files on this branch and no requirement here needs its internals touched.
- **Anonymous use must not regress.** Nothing may gate a function on being signed in.
- **No new permissions.** Per-tab panel instances need only a `tabId`, which tab events supply; reading `tab.url` would need the `tabs` permission, which this project has deliberately declined.
- **Concurrency cap is exactly 5.** Server rate limit is 30 requests / 60s per IP (`src/lib/rate-limit.ts:9-10`) and one run costs 3 calls; 5 runs = 15 calls leaves headroom, and matches the 5/day signed-in allowance.
- **`STALE_RUN_MS` is exactly 5 minutes**, and staleness is judged on READ, never on write.
- UI copy, code, and comments are English.
- **Baseline:** extension 184/184, root 84/84, `npx tsc --noEmit --project extension/tsconfig.json`, both lints, both builds — all clean.

---

## ⚠️ Read this before Task 3

Earlier plans on this branch declared `App.tsx`'s concurrency machinery off limits: `runningForUrlRef`, `runningSupplementRef`, `activeJdUrlRef`, and the JD-change effect's guards. **This plan deliberately dismantles most of it**, because it exists only to solve a problem this plan removes at the root.

Those refs exist because `runTailor` *pushes* patches into a single `state`, so the panel must constantly ask "is this patch still for the posting I'm showing?". Once run state is *read per-URL from storage*, that question disappears — you render the state belonging to the URL you are on, and there is nothing to mis-route.

**This is the highest-risk part of the plan.** Each of those guards was added in response to a real, user-visible bug (a paid-for result wiped from screen; one posting's supplement submitted as another's). The tests pinning those bugs are in `extension/src/sidepanel/__tests__/App.test.tsx`.

**The rule for Task 3:** every existing test in that file must still pass, OR — where a test pins a mechanism that genuinely no longer exists — it must be replaced by one asserting the same *user-visible* guarantee through the new mechanism, and the report must name the test, quote the guarantee, and explain why the rewrite preserves it. **Deleting such a test without a replacement is a task failure, not a judgment call.**

---

## File Structure

| File | Responsibility | Task |
|------|----------------|------|
| `extension/src/lib/liveRuns.ts` (new) | `cp_live_runs` read/write + stale detection. Pure data layer, no business logic. | 1 |
| `extension/src/lib/__tests__/liveRuns.test.ts` (new) | Stale detection and the read/write contract. | 1 |
| `extension/src/background/runs.ts` (new) | Run registry: start, concurrency cap, write progress to storage, cache on success. | 2 |
| `extension/src/background/index.ts` (modify) | Register the `onMessage` handler; register tab events for per-tab panels. | 2, 4 |
| `extension/src/sidepanel/App.tsx` (modify) | Stop calling `runTailor`; send a start message and render from storage. | 3 |
| `extension/src/sidepanel/__tests__/App.test.tsx` (modify) | Rewire existing tests to the new mechanism; add new ones. | 3 |
| `extension/src/lib/run.ts` | **Unchanged.** | — |

---

## Task 1: The live-run store

**Files:**
- Create: `extension/src/lib/liveRuns.ts`
- Test: `extension/src/lib/__tests__/liveRuns.test.ts`

**Interfaces:**
- Consumes: `RunState` from `@/lib/run`; `cacheKey` from `@/lib/cache`.
- Produces:
  ```ts
  export const STALE_RUN_MS = 5 * 60 * 1000;
  export const MAX_CONCURRENT_RUNS = 5;
  export interface LiveRun { state: RunState; jdTitle: string; updatedAt: number }
  export function isRunning(state: RunState): boolean;
  export async function getLiveRun(url: string): Promise<LiveRun | null>;
  export async function getAllLiveRuns(): Promise<Record<string, LiveRun>>;
  export async function putLiveRun(url: string, run: LiveRun): Promise<void>;
  export async function clearLiveRun(url: string): Promise<void>;
  ```

**Background:** `extension/src/lib/cache.ts` stores *finished* results under `cp_results`. This module is its sibling for *in-flight* runs under `cp_live_runs`. Read `cache.ts` first and mirror its conventions — a JSON string under one key, a `readAll` helper wrapped in try/catch that treats unreadable data as empty, and doc comments that say *why*.

**The stale rule, which is the point of this module.** MV3 terminates an idle service worker after ~30 seconds. An in-flight `fetch` extends that, so a normal one-minute run survives — but a browser restart, a crash, or an eviction can strand a run mid-flight. Nothing would then move that record to a terminal state, and the panel would spin forever. So a run still in a running phase whose `updatedAt` is older than `STALE_RUN_MS` reads back as failed.

**Judge staleness on READ, never on write.** If the service worker is gone, it cannot mark its own run as failed — only the reader is guaranteed to be alive.

- [ ] **Step 1: Write the failing tests**

Create `extension/src/lib/__tests__/liveRuns.test.ts`. Read an existing lib test (e.g. `storage.test.ts`) first and follow its `chrome.storage` faking pattern.

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { RunState } from "../run";
import {
  STALE_RUN_MS,
  getLiveRun,
  putLiveRun,
  clearLiveRun,
  getAllLiveRuns,
  isRunning,
} from "../liveRuns";

const RUNNING: RunState = {
  phase: "comparing",
  analysis: null,
  tailored: null,
  remaining: null,
  error: null,
};

const URL_A = "https://example.com/jobs/1";

beforeEach(() => {
  const data: Record<string, unknown> = {};
  vi.stubGlobal("chrome", {
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
  });
});

describe("liveRuns", () => {
  it("round-trips a run under its normalized posting key", async () => {
    await putLiveRun(URL_A, { state: RUNNING, jdTitle: "Staff MLE", updatedAt: Date.now() });

    const got = await getLiveRun(URL_A);
    expect(got?.state.phase).toBe("comparing");
    expect(got?.jdTitle).toBe("Staff MLE");
  });

  // Tracking parameters must not create a second entry — cache.ts already
  // normalizes this way, and the two stores have to agree on what "the same
  // posting" means or a live run and its cached result key differently.
  it("treats a tracking-parameter variant as the same posting", async () => {
    await putLiveRun(URL_A, { state: RUNNING, jdTitle: "Staff MLE", updatedAt: Date.now() });

    expect(await getLiveRun(`${URL_A}?utm_source=newsletter`)).not.toBeNull();
  });

  // THE POINT OF THIS MODULE. A stranded service worker cannot mark its own
  // run failed, so a run that stopped being updated reads back as failed
  // rather than spinning forever.
  it("reports a run abandoned longer than STALE_RUN_MS as failed", async () => {
    await putLiveRun(URL_A, {
      state: RUNNING,
      jdTitle: "Staff MLE",
      updatedAt: Date.now() - STALE_RUN_MS - 1,
    });

    const got = await getLiveRun(URL_A);
    expect(got?.state.phase).toBe("error");
    expect(got?.state.error?.kind).toBe("server");
    expect(got?.state.error?.message).toBe(
      "That run stopped before it finished. Try again.",
    );
  });

  it("leaves a recently updated run alone", async () => {
    await putLiveRun(URL_A, {
      state: RUNNING,
      jdTitle: "Staff MLE",
      updatedAt: Date.now() - 1000,
    });

    expect((await getLiveRun(URL_A))?.state.phase).toBe("comparing");
  });

  // Only RUNNING phases go stale. A finished-with-error record is a real
  // answer and must survive however long it sits there.
  it("never rewrites a terminal state, however old", async () => {
    const failed: RunState = {
      ...RUNNING,
      phase: "error",
      error: { kind: "quota", message: "You've used all your free runs." },
    };
    await putLiveRun(URL_A, {
      state: failed,
      jdTitle: "Staff MLE",
      updatedAt: Date.now() - STALE_RUN_MS * 10,
    });

    expect((await getLiveRun(URL_A))?.state.error?.kind).toBe("quota");
  });

  it("clears one posting without touching the others", async () => {
    const other = "https://example.com/jobs/2";
    await putLiveRun(URL_A, { state: RUNNING, jdTitle: "A", updatedAt: Date.now() });
    await putLiveRun(other, { state: RUNNING, jdTitle: "B", updatedAt: Date.now() });

    await clearLiveRun(URL_A);

    expect(await getLiveRun(URL_A)).toBeNull();
    expect(await getLiveRun(other)).not.toBeNull();
  });

  // getAllLiveRuns backs the concurrency cap, so it must apply the same stale
  // rule — otherwise abandoned runs would occupy slots forever and the sixth
  // real run would be refused on behalf of five ghosts.
  it("applies the stale rule to getAllLiveRuns too", async () => {
    await putLiveRun(URL_A, {
      state: RUNNING,
      jdTitle: "A",
      updatedAt: Date.now() - STALE_RUN_MS - 1,
    });

    const all = await getAllLiveRuns();
    expect(Object.values(all)[0].state.phase).toBe("error");
  });

  it("isRunning is true only for in-flight phases", () => {
    expect(isRunning({ ...RUNNING, phase: "reading" })).toBe(true);
    expect(isRunning({ ...RUNNING, phase: "comparing" })).toBe(true);
    expect(isRunning({ ...RUNNING, phase: "writing" })).toBe(true);
    expect(isRunning({ ...RUNNING, phase: "idle" })).toBe(false);
    expect(isRunning({ ...RUNNING, phase: "done" })).toBe(false);
    expect(isRunning({ ...RUNNING, phase: "error" })).toBe(false);
  });
});
```

Before writing the implementation, open `extension/src/lib/run.ts` and confirm the exact `RunPhase` union — if the phase names differ from `idle`/`reading`/`comparing`/`writing`/`done`/`error`, use the file's real names in both the test and `isRunning`.

- [ ] **Step 2: Run them and confirm they fail**

```bash
npm --prefix extension run test -- src/lib/__tests__/liveRuns.test.ts
```

Expected: FAIL — `../liveRuns` does not exist.

- [ ] **Step 3: Write `extension/src/lib/liveRuns.ts`**

```ts
import { cacheKey } from "./cache";
import type { RunState } from "./run";

/**
 * Runs currently in flight, keyed per posting in chrome.storage.local.
 *
 * The sibling of cache.ts: that module stores FINISHED results under
 * `cp_results`, this one stores IN-FLIGHT runs under `cp_live_runs`. Both key
 * on cacheKey(url), and they must keep agreeing on that — a live run and the
 * cached result it becomes have to be reachable by the same key or a finished
 * run looks like it belongs to a different posting.
 *
 * Storage is the channel deliberately, rather than a runtime message port.
 * The panel can be destroyed at any moment; storage outlives it, so a newly
 * opened panel reads current state with no handshake, and chrome.storage
 * .onChanged broadcasts progress to every open panel for free.
 */

const LIVE_RUNS_KEY = "cp_live_runs";

/**
 * How long a run may go without a status update before a reader treats it as
 * dead. MV3 evicts an idle service worker after ~30s; an in-flight fetch
 * extends that, so a normal run (about a minute) survives — but a browser
 * restart or a crash can strand one mid-flight, and nothing would ever move
 * that record to a terminal state. Five minutes is generous against a slow
 * model call while still well short of "the user is staring at a dead
 * spinner".
 */
export const STALE_RUN_MS = 5 * 60 * 1000;

/**
 * The ceiling on simultaneous runs. Not arbitrary: the server rate-limits 30
 * requests per 60s per IP and one run costs three calls, so ten concurrent
 * runs would saturate it exactly and start failing everything, including
 * other tabs. Five costs fifteen calls and leaves headroom — and matches the
 * signed-in allowance of five runs a day, beyond which extra parallelism buys
 * a user nothing anyway.
 */
export const MAX_CONCURRENT_RUNS = 5;

export interface LiveRun {
  state: RunState;
  /** The posting's title, for debugging and for any future summary view. */
  jdTitle: string;
  /** Epoch ms of the last status update. See STALE_RUN_MS. */
  updatedAt: number;
}

const STALE_ERROR = "That run stopped before it finished. Try again.";

/** Whether this state is still in flight, as opposed to idle or terminal. */
export function isRunning(state: RunState): boolean {
  return state.phase === "reading" || state.phase === "comparing" || state.phase === "writing";
}

async function readAll(): Promise<Record<string, LiveRun>> {
  try {
    const got = await chrome.storage.local.get([LIVE_RUNS_KEY]);
    const raw = got[LIVE_RUNS_KEY];
    if (typeof raw !== "string") return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, LiveRun>)
      : {};
  } catch {
    // Corrupt or unreadable — treat as empty rather than breaking the panel.
    return {};
  }
}

/**
 * Applied on READ, never on write, and that asymmetry is the whole design: if
 * the service worker has been evicted it cannot mark its own run failed, so
 * the only participant guaranteed to be alive is whoever is reading.
 */
function withStaleRule(run: LiveRun): LiveRun {
  if (!isRunning(run.state)) return run;
  if (Date.now() - run.updatedAt <= STALE_RUN_MS) return run;
  return {
    ...run,
    state: {
      ...run.state,
      phase: "error",
      error: { kind: "server", message: STALE_ERROR },
    },
  };
}

export async function getLiveRun(url: string): Promise<LiveRun | null> {
  const hit = (await readAll())[cacheKey(url)];
  return hit ? withStaleRule(hit) : null;
}

/** Every run, stale rule applied — this is what the concurrency cap counts. */
export async function getAllLiveRuns(): Promise<Record<string, LiveRun>> {
  const all = await readAll();
  const out: Record<string, LiveRun> = {};
  for (const [key, run] of Object.entries(all)) out[key] = withStaleRule(run);
  return out;
}

export async function putLiveRun(url: string, run: LiveRun): Promise<void> {
  const all = await readAll();
  all[cacheKey(url)] = run;
  await chrome.storage.local.set({ [LIVE_RUNS_KEY]: JSON.stringify(all) });
}

export async function clearLiveRun(url: string): Promise<void> {
  const all = await readAll();
  delete all[cacheKey(url)];
  await chrome.storage.local.set({ [LIVE_RUNS_KEY]: JSON.stringify(all) });
}
```

- [ ] **Step 4: Run them and confirm they pass**

```bash
npm --prefix extension run test -- src/lib/__tests__/liveRuns.test.ts
```

- [ ] **Step 5: Full verification**

```bash
npx tsc --noEmit --project extension/tsconfig.json && npm --prefix extension run test && npm --prefix extension run lint && npm --prefix extension run build
```

Expected: all clean; 184 + 8 new tests.

- [ ] **Step 6: Commit**

```bash
git add extension/src/lib/liveRuns.ts extension/src/lib/__tests__/liveRuns.test.ts
git commit -m "feat(extension): a per-posting store for in-flight runs"
```

---

## Task 2: The background run registry

**Files:**
- Create: `extension/src/background/runs.ts`
- Modify: `extension/src/background/index.ts`
- Test: `extension/src/background/__tests__/runs.test.ts` (new)

**Interfaces:**
- Consumes: everything Task 1 produced; `runTailor`, `newRunId`, `INITIAL_RUN_STATE` from `@/lib/run`; `getCachedRun`, `putCachedRun`, `cacheKey` from `@/lib/cache`.
- Produces:
  ```ts
  export interface StartRunMessage {
    type: "start-run";
    jd: ExtractedJD;
    resume: ParsedResume;
    supplement: string;
    fingerprint: string;
  }
  export type StartRunResult = { started: true } | { started: false; reason: "at-capacity" | "already-running" };
  export function startRun(msg: StartRunMessage): Promise<StartRunResult>;
  ```

**What moves here, and why all of it.** `App.tsx`'s `generate()` today does far more than call `runTailor` — it picks the run id (reusing the posting's existing one makes a refine free), reads the frozen baseline score, and writes the finished result to the cache. **All of that must move**, because all of it must happen even when the panel is gone. Read `App.tsx`'s `generate()` in full before writing this, and carry the reasoning in its comments across — those comments record real bugs.

Two rules from that function that must survive intact:

1. **Refine reuses the posting's run id; a first run mints a new one.** That is what makes a refinement free rather than charged.
2. **The baseline comes from the cache, not from a fresh measurement.** Re-measuring is what made the panel show the score *dropping* after a user added experience. Read it with `getCachedRun(forUrl, fingerprint)` and fall back to this run's analyze score only when there is no prior entry.

- [ ] **Step 1: Write the failing tests**

Create `extension/src/background/__tests__/runs.test.ts`. Mock `@/lib/run`'s `runTailor` so the test drives phases directly, and let `liveRuns`/`cache` run for real against a faked `chrome.storage` (copy the fake from `liveRuns.test.ts`).

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { RunState } from "@/lib/run";
import { getLiveRun, putLiveRun, MAX_CONCURRENT_RUNS } from "@/lib/liveRuns";
import { getCachedRun } from "@/lib/cache";
import { startRun } from "../runs";

// ... chrome.storage fake in beforeEach, as in liveRuns.test.ts ...

let runTailorImpl: (
  jd: unknown,
  resume: unknown,
  onUpdate: (patch: Partial<RunState>) => void,
  opts: { extraInfo?: string; runId?: string },
) => Promise<void> = async () => {};
let runTailorOpts: Array<{ extraInfo?: string; runId?: string }> = [];

vi.mock("@/lib/run", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/run")>();
  return {
    ...actual,
    runTailor: (jd: unknown, resume: unknown, onUpdate: (p: Partial<RunState>) => void, opts: { extraInfo?: string; runId?: string }) => {
      runTailorOpts.push(opts);
      return runTailorImpl(jd, resume, onUpdate, opts);
    },
  };
});

const JD = { text: "job text", title: "Staff MLE", company: "Acme", url: "https://example.com/jobs/1" };
const RESUME = { contact: { name: "Ada" } } as never;
const FP = "fingerprint-1";
const msg = () => ({ type: "start-run" as const, jd: JD, resume: RESUME, supplement: "", fingerprint: FP });

describe("startRun", () => {
  it("publishes progress to the live-run store as the run advances", async () => {
    let emit!: (p: Partial<RunState>) => void;
    runTailorImpl = (_jd, _resume, onUpdate) =>
      new Promise((resolve) => {
        emit = onUpdate;
        void resolve;
      });

    await startRun(msg());
    emit({ phase: "comparing" });
    await Promise.resolve();

    expect((await getLiveRun(JD.url))?.state.phase).toBe("comparing");
  });

  it("caches the result and clears the live run when the run finishes", async () => {
    runTailorImpl = async (_jd, _resume, onUpdate) => {
      onUpdate({
        phase: "done",
        analysis: { overall_match_score: 70 } as never,
        tailored: { projected_match_score: 78 } as never,
      });
    };

    await startRun(msg());
    await new Promise((r) => setTimeout(r, 0));

    expect(await getCachedRun(JD.url, FP)).not.toBeNull();
    expect(await getLiveRun(JD.url)).toBeNull();
  });

  // A failure must PERSIST. If it did not, a background run that failed would
  // leave nothing behind, and returning to the posting would show a blank
  // panel — strictly worse than today, where the error is at least on screen.
  it("keeps a failure in the live-run store so the user finds it on return", async () => {
    runTailorImpl = async (_jd, _resume, onUpdate) => {
      onUpdate({ phase: "error", error: { kind: "quota", message: "No runs left." } });
    };

    await startRun(msg());
    await new Promise((r) => setTimeout(r, 0));

    expect((await getLiveRun(JD.url))?.state.error?.kind).toBe("quota");
  });

  it("refuses a sixth concurrent run rather than queueing it", async () => {
    runTailorImpl = () => new Promise(() => {});
    for (let i = 0; i < MAX_CONCURRENT_RUNS; i++) {
      await startRun({ ...msg(), jd: { ...JD, url: `https://example.com/jobs/${i}` } });
    }

    const result = await startRun({ ...msg(), jd: { ...JD, url: "https://example.com/jobs/x" } });

    expect(result).toEqual({ started: false, reason: "at-capacity" });
  });

  it("refuses a second run for a posting already running", async () => {
    runTailorImpl = () => new Promise(() => {});
    await startRun(msg());

    expect(await startRun(msg())).toEqual({ started: false, reason: "already-running" });
  });

  // Reusing the posting's run id is what makes a refinement free instead of
  // charged. Losing this silently costs the user a run per refinement.
  it("reuses the posting's existing run id when refining", async () => {
    await putCachedRunFixture(JD.url, { runId: "run-abc", baselineScore: 61, fingerprint: FP });
    runTailorImpl = async () => {};

    await startRun({ ...msg(), supplement: "I also led migrations." });

    expect(runTailorOpts.at(-1)?.runId).toBe("run-abc");
  });

  // Re-measuring the baseline is what made the panel show the score DROPPING
  // after a user added experience. The stored one carries forward unchanged.
  it("carries the stored baseline forward instead of re-measuring", async () => {
    await putCachedRunFixture(JD.url, { runId: "run-abc", baselineScore: 61, fingerprint: FP });
    runTailorImpl = async (_jd, _resume, onUpdate) => {
      onUpdate({
        phase: "done",
        analysis: { overall_match_score: 70 } as never,
        tailored: { projected_match_score: 78 } as never,
      });
    };

    await startRun({ ...msg(), supplement: "More detail." });
    await new Promise((r) => setTimeout(r, 0));

    expect((await getCachedRun(JD.url, FP))?.baselineScore).toBe(61);
  });
});
```

Write a small local `putCachedRunFixture(url, {runId, baselineScore, fingerprint})` helper that calls the real `putCachedRun` with plausible `analysis`/`tailored`/`generatedAt`/`extraInfo` values — do not hand-write the storage JSON, or the test stops testing the real read path.

- [ ] **Step 2: Run them and confirm they fail**

```bash
npm --prefix extension run test -- src/background/__tests__/runs.test.ts
```

Expected: FAIL — `../runs` does not exist.

- [ ] **Step 3: Write `extension/src/background/runs.ts`**

```ts
import type { ExtractedJD } from "@/content/extract";
import type { ParsedResume } from "@shared/contract";
import { cacheKey, getCachedRun, putCachedRun } from "@/lib/cache";
import {
  MAX_CONCURRENT_RUNS,
  clearLiveRun,
  getAllLiveRuns,
  getLiveRun,
  isRunning,
  putLiveRun,
} from "@/lib/liveRuns";
import { INITIAL_RUN_STATE, newRunId, runTailor, type RunState } from "@/lib/run";

/**
 * Runs live here, not in the panel, so that closing the panel or switching
 * tabs cannot kill one. The panel starts a run with this message and then
 * only ever READS state back out of lib/liveRuns.
 */
export interface StartRunMessage {
  type: "start-run";
  jd: ExtractedJD;
  resume: ParsedResume;
  supplement: string;
  /** Which resume this run is for — see lib/fingerprint.ts. */
  fingerprint: string;
}

export type StartRunResult =
  | { started: true }
  | { started: false; reason: "at-capacity" | "already-running" };

export async function startRun(msg: StartRunMessage): Promise<StartRunResult> {
  const forUrl = cacheKey(msg.jd.url);

  const existing = await getLiveRun(forUrl);
  if (existing && isRunning(existing.state)) return { started: false, reason: "already-running" };

  const running = Object.values(await getAllLiveRuns()).filter((r) => isRunning(r.state));
  if (running.length >= MAX_CONCURRENT_RUNS) return { started: false, reason: "at-capacity" };

  // Refining reuses this posting's run id, which is what makes it free; a
  // first run — or one after an entry too old to carry an id — mints a new
  // one and is charged.
  const prior = await getCachedRun(forUrl, msg.fingerprint);
  const runId = msg.supplement.trim().length > 0 && prior?.runId ? prior.runId : newRunId();

  const publish = (state: RunState) =>
    putLiveRun(forUrl, { state, jdTitle: msg.jd.title, updatedAt: Date.now() });

  await publish({ ...INITIAL_RUN_STATE, phase: "reading" });

  // Deliberately not awaited: the caller is a message handler and must answer
  // "started" immediately. The run's own writes are what the panel watches.
  void (async () => {
    let latest: RunState = INITIAL_RUN_STATE;
    try {
      await runTailor(
        msg.jd,
        msg.resume,
        (patch) => {
          latest = { ...latest, ...patch };
          void publish(latest);
        },
        { extraInfo: msg.supplement, runId },
      );

      if (latest.phase === "done" && latest.analysis && latest.tailored) {
        // The baseline is READ, not re-measured. Recomputing it per run is
        // what made the panel show the "before" score dropping after a user
        // added experience — the number is meant to be what it says.
        const baseline = prior?.baselineScore ?? latest.analysis.overall_match_score;
        await putCachedRun(forUrl, {
          analysis: latest.analysis,
          tailored: latest.tailored,
          generatedAt: new Date().toISOString(),
          extraInfo: msg.supplement,
          runId,
          baselineScore: baseline,
          resumeFingerprint: msg.fingerprint,
        });
        // Success moves the record from "in flight" to "cached"; a failure
        // deliberately stays put, so returning to the posting shows the error
        // rather than a blank panel.
        await clearLiveRun(forUrl);
      }
    } catch (err) {
      // runTailor folds its own failures into RunState, so reaching here means
      // something unexpected — record it rather than leaving a run that never
      // reaches a terminal state.
      await publish({
        ...latest,
        phase: "error",
        error: {
          kind: "server",
          message: err instanceof Error ? err.message : "Something went wrong.",
        },
      });
    }
  })();

  return { started: true };
}
```

- [ ] **Step 4: Register the message handler**

In `extension/src/background/index.ts`, add:

```ts
import { startRun, type StartRunMessage } from "./runs";

// Runs are owned by this worker so the panel can be closed, switched away
// from, or destroyed without killing one. `sendMessage` wakes this worker if
// it has been evicted, which is standard MV3 behaviour and needs no handling.
chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;
  if ((message as { type?: unknown }).type !== "start-run") return false;
  void startRun(message as StartRunMessage).then(sendResponse);
  // `true` keeps the message channel open for the async reply. Returning
  // anything else closes it and the caller's promise resolves undefined.
  return true;
});
```

- [ ] **Step 5: Run the tests and confirm they pass**

```bash
npm --prefix extension run test -- src/background/__tests__/runs.test.ts
```

- [ ] **Step 6: Full verification**

```bash
npx tsc --noEmit --project extension/tsconfig.json && npm --prefix extension run test && npm --prefix extension run lint && npm --prefix extension run build
```

- [ ] **Step 7: Commit**

```bash
git add extension/src/background/runs.ts extension/src/background/index.ts extension/src/background/__tests__/runs.test.ts
git commit -m "feat(extension): run generations in the background service worker"
```

---

## Task 3: The panel becomes a view

**Files:**
- Modify: `extension/src/sidepanel/App.tsx`
- Test: `extension/src/sidepanel/__tests__/App.test.tsx`

**Interfaces:**
- Consumes: `getLiveRun`, `isRunning`, `LiveRun` from `@/lib/liveRuns`; `StartRunMessage`, `StartRunResult` from `@/background/runs`.
- Produces: nothing new exported.

**⚠️ Re-read the warning block near the top of this plan before starting.** This task removes guards that earlier plans protected, and the rule about replacing rather than deleting their tests is binding.

**What changes.** `generate()` stops calling `runTailor` and instead:

```ts
const result = (await chrome.runtime.sendMessage({
  type: "start-run",
  jd,
  resume: stored.resume,
  supplement,
  fingerprint,
} satisfies StartRunMessage)) as StartRunResult;
```

On `{ started: false, reason: "at-capacity" }` show exactly:
`Five postings are already generating. Wait for one to finish.`
On `{ started: false, reason: "already-running" }` do nothing visible — the panel is about to show that run's progress anyway.

**What the panel renders.** Displayed state for the current posting becomes, in order of precedence:

1. the live run for this URL, if one exists (running *or* failed)
2. otherwise the cached result for this URL
3. otherwise `INITIAL_RUN_STATE`

`busy` becomes derived — `isRunning(liveRun.state)` — not a `useState` the panel sets itself.

**What goes away, and why it is safe.** `runningForUrlRef`, `runningSupplementRef`, and the "a live run owns the display" branch of the JD-change effect all exist because `runTailor` *pushed* patches into one shared `state`, so the panel had to keep asking "is this patch still for the posting I am showing?". State is now *read per URL*: you render what belongs to the URL you are on, and a patch for another posting cannot arrive at all. Keep `activeJdUrlRef` only if something still reads it after the rewrite; if nothing does, remove it.

**Subscribe to storage.** Extend the existing `chrome.storage.onChanged` listener (added for the sign-in signal) to also re-read the live run when `cp_live_runs` changes. Do not add a second listener.

- [ ] **Step 1: Inventory the tests you are about to affect**

Before changing anything, run:

```bash
npm --prefix extension run test -- src/sidepanel/__tests__/App.test.tsx
```

and list every test whose name mentions tab switching, in-flight runs, or the supplement. For each, write down in one line *what user-visible guarantee it protects* — not what mechanism it pokes. That list goes in your report and is what you check the rewrite against.

- [ ] **Step 2: Write the failing tests**

Add a new describe block. Mock `chrome.runtime.sendMessage` alongside the existing fakes.

```ts
describe("App - runs owned by the background", () => {
  it("asks the background to start a run instead of running it in the panel", async () => {
    activeJdState = { jd: JD_A, failure: null, loading: false };
    await setResume(STORED_RESUME);
    await renderApp();

    await act(async () => {
      findButton(container, "Tailor my resume").click();
    });
    await flush();

    const sent = sendMessageCalls.at(-1) as { type: string; supplement: string };
    expect(sent.type).toBe("start-run");
    expect(runTailorCalls.length).toBe(0);
  });

  it("shows a run already in flight when the panel opens", async () => {
    await putLiveRun(JD_A.url, {
      state: { phase: "comparing", analysis: null, tailored: null, remaining: null, error: null },
      jdTitle: "Staff MLE",
      updatedAt: Date.now(),
    });
    activeJdState = { jd: JD_A, failure: null, loading: false };
    await setResume(STORED_RESUME);
    await renderApp();

    expect(findButton(container, "Working…")).toBeTruthy();
  });

  // The panel is a view: progress arrives as a storage change, not a callback.
  it("advances as the background publishes progress", async () => {
    activeJdState = { jd: JD_A, failure: null, loading: false };
    await setResume(STORED_RESUME);
    await renderApp();

    await putLiveRun(JD_A.url, {
      state: { phase: "done", analysis: ANALYSIS, tailored: TAILORED, remaining: 4, error: null },
      jdTitle: "Staff MLE",
      updatedAt: Date.now(),
    });
    await act(async () => {
      fireStorageChange({ cp_live_runs: { newValue: "changed" } });
    });
    await flush();

    expect(container.textContent).toContain("Ada Lovelace");
  });

  // The point of the whole plan: a run belongs to the posting, so leaving and
  // coming back finds it still going rather than gone.
  it("keeps showing a posting's run after switching away and back", async () => {
    activeJdState = { jd: JD_A, failure: null, loading: false };
    await setResume(STORED_RESUME);
    await renderApp();
    await putLiveRun(JD_A.url, {
      state: { phase: "comparing", analysis: null, tailored: null, remaining: null, error: null },
      jdTitle: "Staff MLE",
      updatedAt: Date.now(),
    });

    activeJdState = { jd: JD_B, failure: null, loading: false };
    await renderApp();
    expect(hasButton(container, "Working…")).toBe(false);

    activeJdState = { jd: JD_A, failure: null, loading: false };
    await renderApp();
    expect(findButton(container, "Working…")).toBeTruthy();
  });

  it("surfaces a failed background run when the user returns to that posting", async () => {
    await putLiveRun(JD_A.url, {
      state: {
        phase: "error",
        analysis: null,
        tailored: null,
        remaining: null,
        error: { kind: "quota", message: "You've used all your free runs." },
      },
      jdTitle: "Staff MLE",
      updatedAt: Date.now(),
    });
    activeJdState = { jd: JD_A, failure: null, loading: false };
    await setResume(STORED_RESUME);
    await renderApp();

    expect(container.textContent).toContain("You've used all your free runs.");
  });

  it("explains the concurrency cap rather than failing silently", async () => {
    sendMessageImpl = async () => ({ started: false, reason: "at-capacity" });
    activeJdState = { jd: JD_A, failure: null, loading: false };
    await setResume(STORED_RESUME);
    await renderApp();

    await act(async () => {
      findButton(container, "Tailor my resume").click();
    });
    await flush();

    expect(container.textContent).toContain(
      "Five postings are already generating. Wait for one to finish.",
    );
  });
});
```

`fireStorageChange` is the helper added in the previous plan's Task 3 — reuse it, do not add a second one.

- [ ] **Step 3: Run them and confirm they fail**

```bash
npm --prefix extension run test -- src/sidepanel/__tests__/App.test.tsx
```

- [ ] **Step 4: Rewrite `generate()` and the display derivation**

Follow "What changes" / "What the panel renders" / "What goes away" above. Work in small edits, running the suite after each, so you can tell which change broke which pre-existing test.

- [ ] **Step 5: Reconcile the pre-existing tests**

For every test from your Step 1 inventory that now fails: either make it pass unchanged, or rewrite it to assert the same user-visible guarantee through the new mechanism. **Record each one in your report** with the guarantee it protects and why the rewrite still protects it. A deleted test with no replacement fails this task.

- [ ] **Step 6: Full verification**

```bash
npx tsc --noEmit --project extension/tsconfig.json && npm --prefix extension run test && npm --prefix extension run lint && npm --prefix extension run build
```

- [ ] **Step 7: Commit**

```bash
git add extension/src/sidepanel/App.tsx extension/src/sidepanel/__tests__/App.test.tsx
git commit -m "feat(extension): render runs from the background instead of owning them"
```

---

## Task 4: Per-tab panel instances

**Files:**
- Modify: `extension/src/background/index.ts`
- Test: `extension/src/background/__tests__/panel.test.ts` (new)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: nothing exported.

**Why this needs no new permission.** `chrome.sidePanel.setOptions({ tabId, path })` gives that tab its own panel instance — Chrome's own API documentation says so: *"if the same path is set for this tabId and the default tabId, then the panel for this tabId will be a different instance than the panel for the default tabId."* A `tabId` comes from tab events; **reading `tab.url` would need the `tabs` permission, which this project has declined** — so this task must never inspect a URL. The panel stays available everywhere; only its state stops being shared.

- [ ] **Step 1: Write the failing test**

Create `extension/src/background/__tests__/panel.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";

let onCreatedCb: ((tab: { id?: number }) => void) | undefined;
let setOptionsCalls: Array<{ tabId?: number; path?: string; enabled?: boolean }> = [];

beforeEach(() => {
  setOptionsCalls = [];
  onCreatedCb = undefined;
  vi.resetModules();
  vi.stubGlobal("chrome", {
    sidePanel: {
      setPanelBehavior: vi.fn(async () => {}),
      setOptions: vi.fn(async (o: { tabId?: number; path?: string }) => {
        setOptionsCalls.push(o);
      }),
    },
    tabs: { onCreated: { addListener: vi.fn((cb) => { onCreatedCb = cb; }) } },
    runtime: {
      onInstalled: { addListener: vi.fn() },
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
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npm --prefix extension run test -- src/background/__tests__/panel.test.ts
```

- [ ] **Step 3: Register the tab listener**

In `extension/src/background/index.ts`:

```ts
// Each tab gets its OWN panel instance. Per Chrome's sidePanel docs, setting
// a path for a specific tabId yields a different instance than the default
// panel — which is what stops one posting's panel state from appearing under
// another. This deliberately does NOT look at the tab's URL: doing so would
// require the `tabs` permission, and disabling the panel on unrecognised
// sites would also remove the only route a user has to grant access to a new
// job board.
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id === undefined) return;
  void chrome.sidePanel
    .setOptions({ tabId: tab.id, path: "src/sidepanel/index.html", enabled: true })
    .catch((err) => console.warn("sidePanel.setOptions failed", err));
});
```

- [ ] **Step 4: Run it and confirm it passes**

```bash
npm --prefix extension run test -- src/background/__tests__/panel.test.ts
```

- [ ] **Step 5: Full verification**

```bash
npx tsc --noEmit --project extension/tsconfig.json && npm --prefix extension run test && npm --prefix extension run lint && npm --prefix extension run build
```

- [ ] **Step 6: Commit**

```bash
git add extension/src/background/index.ts extension/src/background/__tests__/panel.test.ts
git commit -m "feat(extension): give each tab its own side panel instance"
```

---

## Live browser verification

Not a task — no subagent can do this, and **the plan's central assumption is only testable here**: that an in-flight `fetch` keeps the MV3 service worker alive for a full run.

1. Start a generation, **close the side panel**, wait, reopen it on the same posting. The run is still going or has finished — not reset.
2. Start a generation, **switch to another tab**, come back. Same.
3. Start a generation, **close the tab entirely**. Reopen the posting later: the result is there.
4. Start generations on **three postings at once**; all three complete.
5. Try a **sixth** concurrent run: the panel says five are already generating.
6. Force a failure (exhaust quota) in the background; return to that posting and confirm the error is on screen rather than a blank panel.
7. Leave a run going and **restart Chrome** mid-run. Reopen the posting: within five minutes it should read *"That run stopped before it finished. Try again."* rather than spinning forever. **This is the stale-rule check and the one most likely to reveal a design flaw.**
8. Open the panel on two different tabs and confirm their contents are independent.

---

## Self-Review

**Spec coverage:** Background ownership → Task 2. Keyed by posting → Tasks 1 & 2. Storage as the channel → Tasks 1 & 3. Stale runs → Task 1 (`withStaleRule`, read-side). Failure persistence → Task 2 (clear on success only) + Task 3 (surfacing it). Concurrency cap of 5 → Tasks 1 & 2. Per-tab instances → Task 4. `run.ts` unchanged → stated in Global Constraints and in no task's file list.

**Placeholder scan:** none — every step carries its code.

**Type consistency:** `LiveRun`, `STALE_RUN_MS`, `MAX_CONCURRENT_RUNS`, `isRunning`, `getLiveRun`, `getAllLiveRuns`, `putLiveRun`, `clearLiveRun` are defined in Task 1 and used under those names in Tasks 2 and 3. `StartRunMessage`/`StartRunResult` are defined in Task 2 and consumed in Task 3. `cacheKey` and `getCachedRun`/`putCachedRun` keep their existing signatures.

**Ordering:** 1 → 2 → 3 is required (each consumes the last). Task 4 is independent and may run at any point.
