import { describe, it, expect, beforeEach, vi } from "vitest";
import type { RunState } from "../run";
import { cacheKey } from "../cache";
import {
  STALE_RUN_MS,
  getLiveRun,
  putLiveRun,
  clearLiveRun,
  clearAllLiveRuns,
  getAllLiveRuns,
  isRunning,
} from "../liveRuns";

const RUNNING: RunState = {
  phase: "comparing",
  analysis: null,
  tailored: null,
  remaining: null,
  rescoredScore: null,
  refining: false,
  measuring: false,
  scoreNote: null,
  downgradedRequirements: [],
  streamingScore: null,
  streamingRows: [],
  streamingResume: null,
  error: null,
};

const FP = "resume-fingerprint-1";

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
    await putLiveRun(URL_A, { state: RUNNING, jdTitle: "Staff MLE", updatedAt: Date.now(), resumeFingerprint: FP });

    const got = await getLiveRun(URL_A);
    expect(got?.state.phase).toBe("comparing");
    expect(got?.jdTitle).toBe("Staff MLE");
  });

  // Tracking parameters must not create a second entry — cache.ts already
  // normalizes this way, and the two stores have to agree on what "the same
  // posting" means or a live run and its cached result key differently.
  it("treats a tracking-parameter variant as the same posting", async () => {
    await putLiveRun(URL_A, { state: RUNNING, jdTitle: "Staff MLE", updatedAt: Date.now(), resumeFingerprint: FP });

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
      resumeFingerprint: FP,
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
      resumeFingerprint: FP,
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
      resumeFingerprint: FP,
    });

    expect((await getLiveRun(URL_A))?.state.error?.kind).toBe("quota");
  });

  // The refine tail is the one flag a terminal record can be stranded with:
  // the worker publishes `done` + `refining: true`, then dies (browser quit,
  // extension reload) before the leg that would clear it. Nothing else ever
  // clears it, and the panel's busy gate counts `refining`, so the posting
  // would say "Working…" forever with no in-panel way out.
  it("clears a refine tail stranded past STALE_RUN_MS", async () => {
    const doneRefining: RunState = { ...RUNNING, phase: "done", refining: true, rescoredScore: 71 };
    await putLiveRun(URL_A, {
      state: doneRefining,
      jdTitle: "Staff MLE",
      updatedAt: Date.now() - STALE_RUN_MS - 1,
      resumeFingerprint: FP,
    });

    const got = await getLiveRun(URL_A);
    expect(got?.state.refining).toBe(false);
    // The run itself finished and its result is valid — only the flag is stale.
    expect(got?.state.phase).toBe("done");
    expect(got?.state.error).toBeNull();
    expect(got?.state.rescoredScore).toBe(71);
    expect(got?.jdTitle).toBe("Staff MLE");
  });

  // The tail legitimately takes 40-60s, so a young one is a live refine, not
  // a stranded one, and must be left to finish.
  it("leaves a refine tail younger than STALE_RUN_MS alone", async () => {
    await putLiveRun(URL_A, {
      state: { ...RUNNING, phase: "done", refining: true },
      jdTitle: "Staff MLE",
      updatedAt: Date.now() - 1000,
      resumeFingerprint: FP,
    });

    expect((await getLiveRun(URL_A))?.state.refining).toBe(true);
  });

  it("clears one posting without touching the others", async () => {
    const other = "https://example.com/jobs/2";
    await putLiveRun(URL_A, { state: RUNNING, jdTitle: "A", updatedAt: Date.now(), resumeFingerprint: FP });
    await putLiveRun(other, { state: RUNNING, jdTitle: "B", updatedAt: Date.now(), resumeFingerprint: FP });

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
      resumeFingerprint: FP,
    });

    const all = await getAllLiveRuns();
    expect(Object.values(all)[0].state.phase).toBe("error");
  });

  // Only reachable by hand-editing chrome.storage.local, or by a future
  // schema change shipping without a migration — no writer in this module
  // can produce it. readAll's own doc comment promises "a corrupt or
  // unreadable blob reads as empty rather than throwing"; this is that same
  // promise applied per entry, not just to the whole blob. Without it,
  // withStaleRule -> isRunning(run.state) -> state.phase throws on
  // `undefined`, and that throw happens outside readAll's try/catch, so
  // getLiveRun rejects instead of resolving null.
  it("a malformed entry reads as absent, not as a throw", async () => {
    await chrome.storage.local.set({
      cp_live_runs: JSON.stringify({
        [cacheKey(URL_A)]: { state: null, updatedAt: 123 },
      }),
    });

    await expect(getLiveRun(URL_A)).resolves.toBeNull();
  });

  // This is the property that matters for the concurrency cap: a throw in
  // getAllLiveRuns would break the cap for every posting at once, not just
  // the corrupt one, so one bad entry must not poison its neighbors.
  it("a malformed entry does not poison its neighbors", async () => {
    const other = "https://example.com/jobs/2";
    await chrome.storage.local.set({
      cp_live_runs: JSON.stringify({
        [cacheKey(URL_A)]: { state: null, updatedAt: 123 },
        [cacheKey(other)]: { state: RUNNING, jdTitle: "B", updatedAt: Date.now(), resumeFingerprint: FP },
      }),
    });

    const all = await getAllLiveRuns();
    expect(Object.keys(all)).toEqual([cacheKey(other)]);
    expect(Object.values(all)[0].jdTitle).toBe("B");
  });

  // The migration rule, and the same one cache.ts states for its own
  // late-added provenance fields: an entry written before `resumeFingerprint`
  // existed cannot be shown to belong to any particular resume, so it reads
  // as absent rather than as a run whose output we would then display. Those
  // entries are already dead — an extension update restarts the worker and
  // kills the fetch — so this loses nothing and avoids a phantom holding a
  // slot against the concurrency cap.
  it("an entry written before resumeFingerprint existed reads as absent", async () => {
    await chrome.storage.local.set({
      cp_live_runs: JSON.stringify({
        [cacheKey(URL_A)]: { state: RUNNING, jdTitle: "Staff MLE", updatedAt: Date.now() },
      }),
    });

    await expect(getLiveRun(URL_A)).resolves.toBeNull();
    expect(Object.keys(await getAllLiveRuns())).toEqual([]);
  });

  // Sign-out's "also remove my resume and saved results from this browser"
  // has to reach this store too, now that the panel renders it.
  it("clearAllLiveRuns removes every posting's run", async () => {
    const other = "https://example.com/jobs/2";
    await putLiveRun(URL_A, {
      state: RUNNING,
      jdTitle: "A",
      updatedAt: Date.now(),
      resumeFingerprint: FP,
    });
    await putLiveRun(other, {
      state: RUNNING,
      jdTitle: "B",
      updatedAt: Date.now(),
      resumeFingerprint: FP,
    });

    await clearAllLiveRuns();

    expect(await getLiveRun(URL_A)).toBeNull();
    expect(await getLiveRun(other)).toBeNull();
    expect(await getAllLiveRuns()).toEqual({});
  });

  // Five runs publishing 4-5 times each, plus a clear apiece, is ~25
  // interleaved read-modify-write cycles on ONE blob. Without serialization
  // the two below both read the same empty blob and the second `set`
  // overwrites the first, so one posting's run simply vanishes from the store
  // — and with it from the concurrency count and from its own panel.
  it("does not lose one posting's write to another posting's overlapping one", async () => {
    const other = "https://example.com/jobs/2";

    // Deliberately not awaited in turn: this is the interleaving the
    // background produces whenever two runs publish within a storage round
    // trip of each other.
    const first = putLiveRun(URL_A, {
      state: RUNNING,
      jdTitle: "A",
      updatedAt: Date.now(),
      resumeFingerprint: FP,
    });
    const second = putLiveRun(other, {
      state: RUNNING,
      jdTitle: "B",
      updatedAt: Date.now(),
      resumeFingerprint: FP,
    });
    await Promise.all([first, second]);

    expect((await getLiveRun(URL_A))?.jdTitle).toBe("A");
    expect((await getLiveRun(other))?.jdTitle).toBe("B");
  });

  // The worse half of the same defect, and the one with a user-visible price:
  // A finishes and is cleared, but B's progress write read the blob a moment
  // earlier and lands afterwards, putting A back with a RUNNING phase and a
  // stale `updatedAt`. The panel then spins over a result that already
  // succeeded, and five minutes later calls that succeeded run stale and
  // invites the user to pay for it again.
  it("does not resurrect a cleared run behind another posting's overlapping write", async () => {
    const other = "https://example.com/jobs/2";
    await putLiveRun(URL_A, {
      state: RUNNING,
      jdTitle: "A",
      updatedAt: Date.now(),
      resumeFingerprint: FP,
    });

    const cleared = clearLiveRun(URL_A);
    const published = putLiveRun(other, {
      state: RUNNING,
      jdTitle: "B",
      updatedAt: Date.now(),
      resumeFingerprint: FP,
    });
    await Promise.all([cleared, published]);

    expect(await getLiveRun(URL_A)).toBeNull();
    expect((await getLiveRun(other))?.jdTitle).toBe("B");
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
