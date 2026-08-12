import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runTailor, type RunState } from "@/lib/run";
import type { ParsedResume } from "@shared/contract";
import type { ExtractedJD } from "@/content/extract";

const RESUME: ParsedResume = {
  contact: { name: "Ada", email: "", phone: "", location: "", links: [] },
  summary: "",
  experience: [],
  projects: [],
  skills: [],
  education: [],
};

const JD: ExtractedJD = {
  text: "a".repeat(400),
  title: "Senior Backend Engineer",
  company: "Acme",
  url: "https://acme.com/jobs/1",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

function collect() {
  const patches: Partial<RunState>[] = [];
  return { patches, onUpdate: (p: Partial<RunState>) => patches.push(p) };
}

function fakeChromeStorage() {
  const data: Record<string, unknown> = { cp_device_token: "tok" };
  return {
    storage: {
      local: {
        get: vi.fn(async (keys: string[]) => {
          const out: Record<string, unknown> = {};
          for (const k of keys) if (k in data) out[k] = data[k];
          return out;
        }),
        set: vi.fn(async (items: Record<string, unknown>) => Object.assign(data, items)),
        remove: vi.fn(async (keys: string[]) => keys.forEach((k) => delete data[k])),
      },
    },
  };
}

describe("runTailor", () => {
  beforeEach(() => {
    vi.stubGlobal("chrome", fakeChromeStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends the SAME runId to analyze and tailor", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith("/api/parse-jd")) return json({ jd: { company: "Acme" } });
      if (String(url).endsWith("/api/analyze")) return json({ analysis: { overall_match_score: 70 }, remaining: 4 });
      return json({ tailored: { projected_match_score: 85 }, remaining: 4 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { onUpdate } = collect();
    await runTailor(JD, RESUME, onUpdate);

    const bodies = fetchMock.mock.calls
      .map((c) => JSON.parse(String((c[1] as RequestInit).body)))
      .filter((b) => "runId" in b);
    expect(bodies).toHaveLength(2);
    expect(bodies[0].runId).toBe(bodies[1].runId);
    expect(bodies[0].runId).toBeTruthy();
  });

  it("mints a new runId on a second run", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        if (body.runId) seen.push(body.runId);
        if (String(url).endsWith("/api/parse-jd")) return json({ jd: {} });
        if (String(url).endsWith("/api/analyze")) return json({ analysis: {}, remaining: 3 });
        return json({ tailored: {}, remaining: 3 });
      }),
    );
    await runTailor(JD, RESUME, () => {});
    await runTailor(JD, RESUME, () => {});
    expect(new Set(seen).size).toBe(2);
  });

  it("reports analysis before the tailored result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("/api/parse-jd")) return json({ jd: {} });
        if (String(url).endsWith("/api/analyze")) return json({ analysis: { overall_match_score: 61 }, remaining: 2 });
        return json({ tailored: { projected_match_score: 80 }, remaining: 2 });
      }),
    );
    const { patches, onUpdate } = collect();
    await runTailor(JD, RESUME, onUpdate);

    const analysisAt = patches.findIndex((p) => p.analysis);
    const tailoredAt = patches.findIndex((p) => p.tailored);
    expect(analysisAt).toBeGreaterThanOrEqual(0);
    expect(tailoredAt).toBeGreaterThan(analysisAt);
    expect(patches.at(-1)?.phase).toBe("done");
  });

  it("surfaces a quota error and stops", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("/api/parse-jd")) return json({ jd: {} });
        return json({ error: "You've used all your free runs." }, 402);
      }),
    );
    const { patches, onUpdate } = collect();
    await runTailor(JD, RESUME, onUpdate);
    expect(patches.at(-1)?.phase).toBe("error");
    expect(patches.at(-1)?.error?.kind).toBe("quota");
  });

  it("stops at a parse-jd failure without calling analyze", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => json({ error: "bad jd" }, 422));
    vi.stubGlobal("fetch", fetchMock);
    const { patches, onUpdate } = collect();
    await runTailor(JD, RESUME, onUpdate);
    expect(patches.at(-1)?.phase).toBe("error");
    expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith("/api/analyze"))).toBe(false);
  });
});
