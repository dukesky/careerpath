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

function run(score: number): CachedRun {
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
  return { analysis, tailored, generatedAt: "2026-08-14T10:00:00.000Z" };
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
    expect(await getCachedRun("https://acme.com/jobs/1")).toBeNull();
  });

  it("round-trips a run", async () => {
    await putCachedRun("https://acme.com/jobs/1", run(62));
    const hit = await getCachedRun("https://acme.com/jobs/1");
    expect(hit?.analysis.overall_match_score).toBe(62);
    expect(hit?.tailored.projected_match_score).toBe(72);
    expect(hit?.generatedAt).toBe("2026-08-14T10:00:00.000Z");
  });

  it("hits the same entry when the url carries tracking parameters", async () => {
    await putCachedRun("https://acme.com/jobs/1", run(62));
    const hit = await getCachedRun("https://acme.com/jobs/1?utm_source=linkedin#top");
    expect(hit?.analysis.overall_match_score).toBe(62);
  });

  it("replaces rather than duplicates when the same posting is tailored again", async () => {
    await putCachedRun("https://acme.com/jobs/1", run(62));
    await putCachedRun("https://acme.com/jobs/1", run(70));
    expect(await countCachedRuns()).toBe(1);
    expect((await getCachedRun("https://acme.com/jobs/1"))?.analysis.overall_match_score).toBe(70);
  });

  it("evicts the oldest once past the cap", async () => {
    for (let i = 0; i < MAX_CACHED_RUNS; i++) {
      await putCachedRun(`https://acme.com/jobs/${i}`, run(i));
    }
    expect(await countCachedRuns()).toBe(MAX_CACHED_RUNS);
    expect(await getCachedRun("https://acme.com/jobs/0")).not.toBeNull();

    await putCachedRun("https://acme.com/jobs/last", run(99));

    expect(await countCachedRuns()).toBe(MAX_CACHED_RUNS);
    expect(await getCachedRun("https://acme.com/jobs/0")).toBeNull();
    expect(await getCachedRun("https://acme.com/jobs/last")).not.toBeNull();
    expect(await getCachedRun("https://acme.com/jobs/1")).not.toBeNull();
  });

  it("clears everything", async () => {
    await putCachedRun("https://acme.com/jobs/1", run(62));
    await putCachedRun("https://acme.com/jobs/2", run(63));
    await clearCachedRuns();
    expect(await countCachedRuns()).toBe(0);
    expect(await getCachedRun("https://acme.com/jobs/1")).toBeNull();
  });

  it("treats a corrupt blob as empty instead of throwing", async () => {
    await chrome.storage.local.set({ cp_results: "{not json" });
    expect(await countCachedRuns()).toBe(0);
    expect(await getCachedRun("https://acme.com/jobs/1")).toBeNull();
    // and it recovers — a write over the corrupt value must still land
    await putCachedRun("https://acme.com/jobs/1", run(62));
    expect(await countCachedRuns()).toBe(1);
  });
});
