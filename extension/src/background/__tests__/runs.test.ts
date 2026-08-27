import { describe, it, expect, beforeEach, vi } from "vitest";
import type { RunState } from "@/lib/run";
import { getLiveRun, MAX_CONCURRENT_RUNS } from "@/lib/liveRuns";
import { getCachedRun, putCachedRun, type CachedRun } from "@/lib/cache";
import { startRun } from "../runs";

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
    runTailor: (
      jd: unknown,
      resume: unknown,
      onUpdate: (p: Partial<RunState>) => void,
      opts: { extraInfo?: string; runId?: string },
    ) => {
      runTailorOpts.push(opts);
      return runTailorImpl(jd, resume, onUpdate, opts);
    },
  };
});

const JD = { text: "job text", title: "Staff MLE", company: "Acme", url: "https://example.com/jobs/1" };
const RESUME = { contact: { name: "Ada" } } as never;
const FP = "fingerprint-1";
const msg = () => ({ type: "start-run" as const, jd: JD, resume: RESUME, supplement: "", fingerprint: FP });

/**
 * Seeds prior cache state by calling the REAL putCachedRun, rather than
 * hand-writing the storage blob — the run-id-reuse and baseline-carry-forward
 * rules under test both depend on getCachedRun's real read path (provenance
 * check on fingerprint + baselineScore), and hand-written JSON would bypass
 * exactly that.
 */
async function putCachedRunFixture(
  url: string,
  { runId, baselineScore, fingerprint }: { runId: string; baselineScore: number; fingerprint: string },
): Promise<void> {
  const fixture: CachedRun = {
    analysis: {
      overall_match_score: baselineScore,
      rationale: "Plausible rationale for a prior run.",
      requirements_matrix: [],
      strengths: [],
      gaps: [],
    } as never,
    tailored: {
      resume: RESUME,
      change_log: [],
      projected_match_score: baselineScore + 5,
    } as never,
    generatedAt: new Date().toISOString(),
    extraInfo: "",
    runId,
    baselineScore,
    resumeFingerprint: fingerprint,
  };
  await putCachedRun(url, fixture);
}

beforeEach(() => {
  runTailorImpl = async () => {};
  runTailorOpts = [];

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
    // A single microtask tick is not enough: the fire-and-forget publish()
    // triggered by onUpdate goes through putLiveRun's own readAll() (an
    // awaited chrome.storage.local.get) before its chrome.storage.local.set,
    // so it needs a macrotask flush to land — same as the sibling test below.
    await new Promise((r) => setTimeout(r, 0));

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
    // The other half of the reuse rule: the reused id must be WRITTEN BACK
    // into the cache too, or the next refine after this one has nothing to
    // find and silently mints a fresh (charged) id. The sibling test above
    // only covers the read half — this covers the write half.
    expect((await getCachedRun(JD.url, FP))?.runId).toBe("run-abc");
  });
});
