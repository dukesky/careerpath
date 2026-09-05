import { describe, it, expect, beforeEach, vi } from "vitest";
import type { RunState } from "@/lib/run";
import { getLiveRun, MAX_CONCURRENT_RUNS } from "@/lib/liveRuns";
import { getCachedRun, putCachedRun, type CachedRun } from "@/lib/cache";
import type { GapAnalysis } from "@shared/contract";
import type { AuthToken } from "@/lib/session";
import { startRun } from "../runs";

interface CapturedOpts {
  extraInfo?: string;
  runId?: string;
  runToken?: string;
  priorAnalysis?: GapAnalysis;
  isRefinement?: boolean;
}

let runTailorImpl: (
  jd: unknown,
  resume: unknown,
  onUpdate: (patch: Partial<RunState>) => void,
  opts: CapturedOpts,
) => Promise<void> = async () => {};
let runTailorOpts: Array<CapturedOpts> = [];

vi.mock("@/lib/run", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/run")>();
  return {
    ...actual,
    runTailor: (
      jd: unknown,
      resume: unknown,
      onUpdate: (p: Partial<RunState>) => void,
      opts: CapturedOpts,
    ) => {
      runTailorOpts.push(opts);
      return runTailorImpl(jd, resume, onUpdate, opts);
    },
  };
});

let authImpl: () => Promise<AuthToken | null> = async () => ({
  kind: "device",
  token: "device-token",
});

// startRun does NOT consult this — it cannot, and must not: this worker has
// no Clerk session, so currentAuthToken() in its realm can only ever answer
// "device", which was the silent downgrade the run token removed. The mock is
// here so the ambient identity can be varied underneath startRun and the
// three "starts normally" tests below can pin that varying it changes
// nothing. (It also keeps an unmocked currentAuthToken() from reaching
// ensureToken(), which fires a real POST to /api/device-token — refused in
// CI, but on a developer machine with the web app running it would mint a
// live token as a side effect of the suite.)
vi.mock("@/lib/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/session")>();
  return { ...actual, currentAuthToken: () => authImpl() };
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
  authImpl = async () => ({ kind: "device", token: "device-token" });

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

  // The rescore lands in a patch AFTER the `done` one (see run.ts), which is
  // the whole reason startRun folds patches into `latest` instead of caching
  // whatever the done patch carried. Caching without it means the number the
  // user watched arrive is gone the moment they revisit the posting.
  it("writes the rescored score into the cache", async () => {
    runTailorImpl = async (_jd, _resume, onUpdate) => {
      onUpdate({
        phase: "done",
        analysis: { overall_match_score: 70 } as never,
        tailored: { projected_match_score: 78 } as never,
      });
      onUpdate({ rescoredScore: 83 });
    };

    await startRun(msg());
    await new Promise((r) => setTimeout(r, 0));

    expect((await getCachedRun(JD.url, FP))?.rescoredScore).toBe(83);
  });

  // The rescore leg is allowed to fail silently, so a `done` run with no
  // rescore is a normal outcome and must still be cached — as an entry with
  // the field absent, indistinguishable from one written before the field
  // existed. See cache.ts's own doc comment.
  it("caches a run whose rescore never landed, with the field absent", async () => {
    runTailorImpl = async (_jd, _resume, onUpdate) => {
      onUpdate({
        phase: "done",
        analysis: { overall_match_score: 70 } as never,
        tailored: { projected_match_score: 78 } as never,
      });
    };

    await startRun(msg());
    await new Promise((r) => setTimeout(r, 0));

    const hit = await getCachedRun(JD.url, FP);
    expect(hit).not.toBeNull();
    expect(hit?.rescoredScore).toBeUndefined();
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

  // A refine run's own analyze fires in PARALLEL with its tailor, so the only
  // gap analysis the tailor leg can possibly see is the previous charged run's
  // — the one already sitting in the cache. Without it the refine rewrite is
  // aimed at nothing and the "add experience, score goes up" loop stops
  // working. A fresh run has no prior matrix and must not be handed one.
  it("passes the cached analysis as priorAnalysis on a refine, and nothing on a fresh run", async () => {
    await putCachedRunFixture(JD.url, { runId: "run-abc", baselineScore: 61, fingerprint: FP });
    const cached = await getCachedRun(JD.url, FP);
    runTailorImpl = async () => {};

    await startRun({ ...msg(), supplement: "I also led migrations." });

    expect(runTailorOpts.at(-1)?.priorAnalysis).toEqual(cached?.analysis);
    expect(runTailorOpts.at(-1)?.runId).toBe("run-abc");

    // A fresh run on a different posting: no prior entry, so nothing to pass.
    await startRun({ ...msg(), jd: { ...JD, url: "https://example.com/jobs/fresh" } });

    expect(runTailorOpts.at(-1)?.priorAnalysis).toBeUndefined();
  });

  // The quota half of the same wiring. A refine run reuses the runId and IS
  // itself the second free leg, so runTailor's auto-refine tail must never
  // fire on it: that tail's rescore would be the runId's fourth call (429),
  // its tailor output could never be adopted, and it would burn the sixth free
  // leg so the NEXT refine gets charged. The flag says so independently of
  // whether a cached analysis happened to exist.
  it("marks a refine run as a refinement so the auto-refine tail cannot fire", async () => {
    await putCachedRunFixture(JD.url, { runId: "run-abc", baselineScore: 61, fingerprint: FP });
    runTailorImpl = async () => {};

    await startRun({ ...msg(), supplement: "I also led migrations." });

    expect(runTailorOpts.at(-1)?.isRefinement).toBe(true);

    // A fresh run is the charged first leg and DOES want the free tail.
    await startRun({ ...msg(), jd: { ...JD, url: "https://example.com/jobs/fresh" } });

    expect(runTailorOpts.at(-1)?.isRefinement).toBe(false);
  });

  // The dangerous shape, pinned because it is REACHABLE, not because it is
  // wrong: a supplement with no cached prior run is a CHARGED run. It happens
  // whenever the user types into the box before any result exists for the
  // posting, and — until the panel started treating the free auto-refine tail
  // as busy — whenever they answered the question cards during that tail,
  // whose cache entry is not written until it settles. `isRefinement` must be
  // false and `priorAnalysis` absent here: there is no earlier leg for this
  // id, so the auto-refine tail is this run's free second leg and the tailor
  // call has no previous matrix to aim at. A future change that reused an id
  // it did not find, or set the flag off the supplement alone, would send the
  // server a refinement of a run that never happened.
  it("mints a fresh charged run id for a supplement with no cached prior run", async () => {
    runTailorImpl = async () => {};

    await startRun({ ...msg(), supplement: "I also led migrations." });

    const first = runTailorOpts.at(-1);
    expect(first?.extraInfo).toBe("I also led migrations.");
    expect(first?.runId).toBeTruthy();
    expect(first?.isRefinement).toBe(false);
    expect(first?.priorAnalysis).toBeUndefined();

    // Freshly MINTED rather than reused: the same shape on another posting
    // gets a different id, which a reuse path could not produce.
    await startRun({
      ...msg(),
      jd: { ...JD, url: "https://example.com/jobs/2" },
      supplement: "I also led migrations.",
    });
    expect(runTailorOpts.at(-1)?.runId).toBeTruthy();
    expect(runTailorOpts.at(-1)?.runId).not.toBe(first?.runId);
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

  // THE CONSTRAINT THIS MUST NOT BREAK. Anonymous use keeps working exactly
  // as before; sign-in is an upgrade, never a gate. The three tests below say
  // it the strongest way available: whatever the ambient identity answers,
  // the run starts. startRun consults it for nothing — a run's identity
  // arrives in the message (`runToken`), minted by the panel — so a gate
  // added back here could not fire, and a gate that cannot fire reads to the
  // next maintainer as the protection and invites deleting the one that is.
  it("starts normally for an anonymous caller on the device identity", async () => {
    authImpl = async () => ({ kind: "device", token: "device-token" });
    expect(await startRun(msg())).toEqual({ started: true });
  });

  it("starts normally for a signed-in caller", async () => {
    authImpl = async () => ({ kind: "clerk", token: "clerk-token" });
    expect(await startRun(msg())).toEqual({ started: true });
  });

  // No device token could be minted and the user is not signed in. The
  // request goes out with no Authorization header and the server treats it as
  // the legacy anon caller — a pre-existing path, not this plan's business.
  it("starts normally when there is no token at all", async () => {
    authImpl = async () => null;
    expect(await startRun(msg())).toEqual({ started: true });
  });

  it("passes the message's run token through to the run", async () => {
    await startRun({ ...msg(), runToken: "run-token-xyz" });
    expect(runTailorOpts.at(-1)?.runToken).toBe("run-token-xyz");
  });

  // No token means an anonymous caller. The run proceeds on the device
  // identity, exactly as it does today.
  it("starts without a run token for an anonymous caller", async () => {
    await startRun(msg());
    expect(runTailorOpts.at(-1)?.runToken).toBeUndefined();
  });
});
