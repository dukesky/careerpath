import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  cacheKey,
  getCachedRun,
  putCachedRun,
  clearCachedRuns,
  countCachedRuns,
  MAX_CACHED_RUNS,
  type CachedRun,
} from "@/lib/cache";
import type { GapAnalysis, ParsedResume, TailorResult } from "@shared/contract";

const RESUME: ParsedResume = {
  contact: { name: "Ada Lovelace", email: "", phone: "", location: "", links: [] },
  summary: "",
  experience: [],
  projects: [],
  skills: [],
  education: [],
};

const FP = "aaaaaaaa";

function run(
  score: number,
  extraInfo = "",
  runId = "rid",
  fingerprint = FP,
): CachedRun {
  const analysis: GapAnalysis = {
    overall_match_score: score,
    rationale: "",
    requirements_matrix: [],
    strengths: [],
    gaps: [],
  };
  const tailored: TailorResult = {
    resume: RESUME,
    change_log: [],
    projected_match_score: score + 10,
  };
  return {
    analysis,
    tailored,
    generatedAt: "2026-08-14T10:00:00.000Z",
    extraInfo,
    runId,
    baselineScore: score,
    resumeFingerprint: fingerprint,
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

describe("cacheKey", () => {
  it("strips utm_* parameters", () => {
    expect(
      cacheKey("https://boards.greenhouse.io/acme/jobs/123?utm_source=linkedin&utm_campaign=x"),
    ).toBe("https://boards.greenhouse.io/acme/jobs/123");
  });

  it("strips ref, source and trk", () => {
    expect(cacheKey("https://jobs.lever.co/acme/abc?ref=twitter&source=feed&trk=public")).toBe(
      "https://jobs.lever.co/acme/abc",
    );
  });

  it("strips the fragment", () => {
    expect(cacheKey("https://acme.com/jobs/9#apply")).toBe("https://acme.com/jobs/9");
  });

  it("keeps parameters that identify the posting", () => {
    expect(cacheKey("https://acme.com/careers?gh_jid=456&utm_source=x")).toBe(
      "https://acme.com/careers?gh_jid=456",
    );
  });

  it("returns an unparseable url verbatim rather than dropping it", () => {
    expect(cacheKey("not a url")).toBe("not a url");
  });
});

describe("result cache", () => {
  beforeEach(() => {
    vi.stubGlobal("chrome", fakeChromeStorage());
  });

  it("returns null for a posting with no cached run", async () => {
    expect(await getCachedRun("https://acme.com/jobs/1", FP)).toBeNull();
  });

  it("round-trips a run", async () => {
    await putCachedRun("https://acme.com/jobs/1", run(62));
    const hit = await getCachedRun("https://acme.com/jobs/1", FP);
    expect(hit?.analysis.overall_match_score).toBe(62);
    expect(hit?.tailored.projected_match_score).toBe(72);
    expect(hit?.generatedAt).toBe("2026-08-14T10:00:00.000Z");
  });

  // Up to five runs finish independently now, so two `get` -> mutate -> `set`
  // cycles on this one key can interleave. Without serialization the second
  // `set` overwrites the first, and a result the user was CHARGED for never
  // reaches cp_results at all — the worst outcome any store here can produce.
  it("does not lose one posting's result to another's overlapping write", async () => {
    // Deliberately not awaited in turn — this is what two runs completing
    // within a storage round trip of each other actually do.
    const first = putCachedRun("https://acme.com/jobs/1", run(62));
    const second = putCachedRun("https://acme.com/jobs/2", run(71));
    await Promise.all([first, second]);

    expect((await getCachedRun("https://acme.com/jobs/1", FP))?.analysis.overall_match_score).toBe(
      62,
    );
    expect((await getCachedRun("https://acme.com/jobs/2", FP))?.analysis.overall_match_score).toBe(
      71,
    );
    expect(await countCachedRuns()).toBe(2);
  });

  it("hits the same entry when the url carries tracking parameters", async () => {
    await putCachedRun("https://acme.com/jobs/1", run(62));
    const hit = await getCachedRun("https://acme.com/jobs/1?utm_source=linkedin#top", FP);
    expect(hit?.analysis.overall_match_score).toBe(62);
  });

  it("replaces rather than duplicates when the same posting is tailored again", async () => {
    await putCachedRun("https://acme.com/jobs/1", run(62));
    await putCachedRun("https://acme.com/jobs/1", run(70));
    expect(await countCachedRuns()).toBe(1);
    expect((await getCachedRun("https://acme.com/jobs/1", FP))?.analysis.overall_match_score).toBe(70);
  });

  it("evicts the oldest once past the cap", async () => {
    for (let i = 0; i < MAX_CACHED_RUNS; i++) {
      await putCachedRun(`https://acme.com/jobs/${i}`, run(i));
    }
    expect(await countCachedRuns()).toBe(MAX_CACHED_RUNS);
    expect(await getCachedRun("https://acme.com/jobs/0", FP)).not.toBeNull();

    await putCachedRun("https://acme.com/jobs/last", run(99));

    expect(await countCachedRuns()).toBe(MAX_CACHED_RUNS);
    expect(await getCachedRun("https://acme.com/jobs/0", FP)).toBeNull();
    expect(await getCachedRun("https://acme.com/jobs/last", FP)).not.toBeNull();
    expect(await getCachedRun("https://acme.com/jobs/1", FP)).not.toBeNull();
  });

  it("clears everything", async () => {
    await putCachedRun("https://acme.com/jobs/1", run(62));
    await putCachedRun("https://acme.com/jobs/2", run(63));
    await clearCachedRuns();
    expect(await countCachedRuns()).toBe(0);
    expect(await getCachedRun("https://acme.com/jobs/1", FP)).toBeNull();
  });

  it("treats a corrupt blob as empty instead of throwing", async () => {
    await chrome.storage.local.set({ cp_results: "{not json" });
    expect(await countCachedRuns()).toBe(0);
    expect(await getCachedRun("https://acme.com/jobs/1", FP)).toBeNull();
    // and it recovers — a write over the corrupt value must still land
    await putCachedRun("https://acme.com/jobs/1", run(62));
    expect(await countCachedRuns()).toBe(1);
  });

  it("round-trips the supplement text and the run id", async () => {
    await putCachedRun("https://acme.com/jobs/1", run(62, "I used PyTorch on X", "run-7"));
    const hit = await getCachedRun("https://acme.com/jobs/1", FP);
    expect(hit?.extraInfo).toBe("I used PyTorch on X");
    expect(hit?.runId).toBe("run-7");
  });

  it("round-trips the baseline and the fingerprint", async () => {
    await putCachedRun("https://acme.com/jobs/1", run(62, "", "rid", "beef1234"));
    const hit = await getCachedRun("https://acme.com/jobs/1", "beef1234");
    expect(hit?.baselineScore).toBe(62);
    expect(hit?.resumeFingerprint).toBe("beef1234");
  });

  it("round-trips the rescored score", async () => {
    await putCachedRun("https://acme.com/jobs/1", { ...run(62), rescoredScore: 71 });
    expect((await getCachedRun("https://acme.com/jobs/1", FP))?.rescoredScore).toBe(71);
  });

  // BACKWARD COMPATIBILITY, and the reason `rescoredScore` is optional rather
  // than part of the provenance rule. Every entry already sitting in a real
  // user's browser lacks this field, as does every entry whose rescore leg
  // failed. Rejecting those would delete results the user paid for, to
  // enforce a field the panel has a working fallback for.
  it("accepts an entry with no rescoredScore, and reports it as absent", async () => {
    await putCachedRun("https://acme.com/jobs/1", run(62));
    const hit = await getCachedRun("https://acme.com/jobs/1", FP);
    expect(hit).not.toBeNull();
    expect(hit?.rescoredScore).toBeUndefined();
    // Everything else still comes back, so the entry is genuinely usable and
    // not merely non-null.
    expect(hit?.baselineScore).toBe(62);
    expect(hit?.tailored.projected_match_score).toBe(72);
  });

  // Same hand-edited-storage hazard the baseline check guards against, with
  // the opposite remedy: a non-finite rescore is DROPPED (the panel falls
  // back to the projection) rather than disqualifying the whole entry, which
  // would throw away a result over a cosmetic field.
  it("drops a non-finite rescoredScore but keeps the entry", async () => {
    const entry = {
      key: "https://acme.com/jobs/1",
      analysis: run(62).analysis,
      tailored: run(62).tailored,
      generatedAt: "2026-08-14T10:00:00.000Z",
      extraInfo: "",
      runId: "rid",
      baselineScore: 62,
      resumeFingerprint: FP,
      rescoredScore: 0,
    };
    const raw = JSON.stringify([entry]).replace('"rescoredScore":0', '"rescoredScore":1e999');
    await chrome.storage.local.set({ cp_results: raw });

    const hit = await getCachedRun("https://acme.com/jobs/1", FP);
    expect(hit).not.toBeNull();
    expect(hit?.rescoredScore).toBeUndefined();
  });

  // The point of the fingerprint: the user replaced their resume, so this
  // entry describes a document that no longer exists. Showing it would tell
  // them we analysed their current resume when we did not.
  it("ignores an entry whose fingerprint does not match the current resume", async () => {
    await putCachedRun("https://acme.com/jobs/1", run(62, "", "rid", "oldresum"));
    expect(await getCachedRun("https://acme.com/jobs/1", "newresum")).toBeNull();
  });

  // Only reachable by hand-editing chrome.storage.local — every real write
  // path clamps the score to 0-100 — but a corrupted value must not sail
  // through the provenance check and hand `roundToFive` an Infinity to
  // render as NaN. JSON.stringify(Infinity) produces `null`, not a number
  // literal (JSON has no way to represent Infinity), so `baselineScore` is
  // spliced into the raw JSON text by hand rather than round-tripped through
  // JSON.stringify, which would silently launder it into `null` and test the
  // wrong case.
  it("ignores an entry whose baselineScore is not finite", async () => {
    const entry = {
      key: "https://acme.com/jobs/1",
      analysis: run(62).analysis,
      tailored: run(62).tailored,
      generatedAt: "2026-08-14T10:00:00.000Z",
      extraInfo: "",
      runId: "rid",
      baselineScore: 0,
      resumeFingerprint: FP,
    };
    const raw = JSON.stringify([entry]).replace('"baselineScore":0', '"baselineScore":1e999');
    expect(raw).toContain("1e999");
    await chrome.storage.local.set({ cp_results: raw });

    expect(await getCachedRun("https://acme.com/jobs/1", FP)).toBeNull();
  });

  // Entries written before these fields existed carry no provenance, so we
  // cannot vouch for which resume produced them. Discarding them is the
  // intended outcome of the one rule, not a migration gap.
  it("ignores an entry written before the fingerprint existed", async () => {
    await chrome.storage.local.set({
      cp_results: JSON.stringify([
        {
          key: "https://acme.com/jobs/legacy",
          analysis: run(50).analysis,
          tailored: run(50).tailored,
          generatedAt: "2026-08-13T09:00:00.000Z",
          extraInfo: "",
          runId: "old-run",
        },
      ]),
    });

    expect(await getCachedRun("https://acme.com/jobs/legacy", FP)).toBeNull();
  });
});
