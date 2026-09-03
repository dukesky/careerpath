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

    const byUrl = new Map(
      fetchMock.mock.calls.map((c) => [
        String(c[0]),
        JSON.parse(String((c[1] as RequestInit).body)),
      ]),
    );
    const analyzeBody = [...byUrl].find(([u]) => u.endsWith("/api/analyze"))?.[1];
    const tailorBody = [...byUrl].find(([u]) => u.endsWith("/api/tailor"))?.[1];

    expect(analyzeBody?.runId).toBeTruthy();
    expect(analyzeBody?.runId).toBe(tailorBody?.runId);
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
        if (String(url).endsWith("/api/rescore")) return json({ score: 83 });
        return json({ tailored: { projected_match_score: 80 }, remaining: 2 });
      }),
    );
    const { patches, onUpdate } = collect();
    await runTailor(JD, RESUME, onUpdate);

    const analysisAt = patches.findIndex((p) => "analysis" in p && p.analysis);
    const tailoredAt = patches.findIndex((p) => "tailored" in p && p.tailored);
    expect(analysisAt).toBeGreaterThanOrEqual(0);
    expect(tailoredAt).toBeGreaterThan(analysisAt);
    // `done` is no longer the LAST patch — the rescore's own patch follows it
    // — but it is still the last one that changes phase.
    expect(patches.filter((p) => p.phase).at(-1)?.phase).toBe("done");
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
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports the lower remaining when the two legs disagree", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (url) => {
        if (String(url).endsWith("/api/parse-jd")) return json({ jd: {} });
        if (String(url).endsWith("/api/analyze")) return json({ analysis: {}, remaining: 2 });
        if (String(url).endsWith("/api/rescore")) return json({ score: 77 });
        return json({ tailored: {}, remaining: 3 });
      }),
    );
    const { patches, onUpdate } = collect();
    await runTailor(JD, RESUME, onUpdate);
    // The rescore patch carries no `remaining` — it is not a charged leg — so
    // read the last patch that actually reported one.
    expect(patches.filter((p) => p.remaining !== undefined).at(-1)?.remaining).toBe(2);
  });

  it("reuses a supplied runId instead of minting one", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (String(url).includes("parse-jd")) return json({ jd: {} });
      return json({ analysis: {}, tailored: {}, remaining: 4 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await runTailor(JD, RESUME, () => {}, { runId: "reused-id" });

    const ids = fetchMock.mock.calls
      .filter((c) => !String(c[0]).includes("parse-jd"))
      .map((c) => JSON.parse(String((c[1] as RequestInit).body)).runId);
    // Three legs now: analyze, tailor, and rescore. The rescore's copy is not
    // incidental — the server's marker gate refuses a runId it has never seen
    // charged, so a rescore sent under a fresh id would 403 on every run.
    expect(ids).toEqual(["reused-id", "reused-id", "reused-id"]);
  });

  it("sends the supplement to both analyze and tailor", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (String(url).includes("parse-jd")) return json({ jd: {} });
      return json({ analysis: {}, tailored: {}, remaining: 4 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await runTailor(JD, RESUME, () => {}, { extraInfo: "I used PyTorch on X" });

    const sent = fetchMock.mock.calls
      .filter((c) => /api\/(analyze|tailor)$/.test(String(c[0])))
      .map((c) => JSON.parse(String((c[1] as RequestInit).body)).extraInfo);
    expect(sent).toEqual(["I used PyTorch on X", "I used PyTorch on X"]);

    // ...and NOT to rescore, deliberately. Rescore measures the TAILORED
    // resume, which has already absorbed the supplement; re-declaring the same
    // facts as "experience not on the resume" would count them twice.
    const rescoreBody = JSON.parse(
      String(
        (fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/api/rescore"))?.[1] as RequestInit)
          .body,
      ),
    );
    expect(rescoreBody.extraInfo).toBeUndefined();
  });

  // Pins the high-risk requirement from the brief: ALL FOUR apiPost calls —
  // parse-jd, analyze, tailor, rescore — must carry the run token, not just
  // the two that happen to run in parallel. Dropping any one of them sends
  // that leg as a device caller with nothing visibly wrong in the UI, and for
  // rescore specifically the symptom is a 403 from the marker gate (the run
  // was charged to the user, so no marker exists under the device key).
  it("sends the runToken as the bearer identity on all four legs", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith("/api/parse-jd")) return json({ jd: {} });
      if (String(url).endsWith("/api/analyze")) return json({ analysis: {}, remaining: 4 });
      if (String(url).endsWith("/api/rescore")) return json({ score: 81 });
      return json({ tailored: {}, remaining: 4 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await runTailor(JD, RESUME, () => {}, { runToken: "run-token-xyz" });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    for (const call of fetchMock.mock.calls) {
      const init = call[1] as RequestInit;
      expect((init.headers as Record<string, string>).Authorization).toBe(
        "Bearer run-token-xyz",
      );
    }
  });

  // ------------------------------------------------------------------ rescore
  //
  // The ordering below is the whole design, not an implementation detail. The
  // `done` patch is first paint for a finished result; the rescore is an
  // analyze-grade model call worth tens of seconds. Any change that lets the
  // rescore land before `done` — awaiting it first, folding it into the same
  // patch — pays the product's most-complained-about cost for a cosmetic gain.

  it("emits the done patch BEFORE the rescore call is even made", async () => {
    const order: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (url) => {
        if (String(url).endsWith("/api/parse-jd")) return json({ jd: {} });
        if (String(url).endsWith("/api/analyze")) return json({ analysis: {}, remaining: 4 });
        if (String(url).endsWith("/api/rescore")) {
          order.push("rescore-request");
          return json({ score: 88 });
        }
        return json({ tailored: { projected_match_score: 80 }, remaining: 4 });
      }),
    );

    await runTailor(JD, RESUME, (patch) => {
      if (patch.phase === "done") order.push("done-patch");
      // `!= null` skips the "reading" patch, which nulls this field to clear
      // the previous run's value.
      if (patch.rescoredScore != null) order.push("rescore-patch");
    });

    expect(order).toEqual(["done-patch", "rescore-request", "rescore-patch"]);
  });

  it("sends the TAILORED resume to rescore, not the original", async () => {
    const tailoredResume = { contact: { name: "Ada (tailored)" }, summary: "rewritten" };
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith("/api/parse-jd")) return json({ jd: { company: "Acme" } });
      if (String(url).endsWith("/api/analyze")) return json({ analysis: {}, remaining: 4 });
      if (String(url).endsWith("/api/rescore")) return json({ score: 88 });
      return json({ tailored: { resume: tailoredResume, projected_match_score: 80 }, remaining: 4 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await runTailor(JD, RESUME, () => {});

    const body = JSON.parse(
      String(
        (fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/api/rescore"))?.[1] as RequestInit)
          .body,
      ),
    );
    // Measuring the ORIGINAL here would produce a second, more expensive copy
    // of the number already on the left and render "72 → 72" on every run.
    expect(body.structuredResume).toEqual(tailoredResume);
    expect(body.structuredJD).toEqual({ company: "Acme" });
  });

  it("publishes the rescored score with the phase still done", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (url) => {
        if (String(url).endsWith("/api/parse-jd")) return json({ jd: {} });
        if (String(url).endsWith("/api/analyze")) return json({ analysis: {}, remaining: 4 });
        if (String(url).endsWith("/api/rescore")) return json({ score: 88 });
        return json({ tailored: { projected_match_score: 80 }, remaining: 4 });
      }),
    );
    const { patches, onUpdate } = collect();
    await runTailor(JD, RESUME, onUpdate);

    expect(patches.at(-1)).toEqual({ rescoredScore: 88 });
    // No phase in the final patch: the run was already `done` and re-sending
    // it is the only way this patch could disturb what is on screen.
    expect(patches.at(-1)?.phase).toBeUndefined();
  });

  it("leaves the run done — never error — when the rescore fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (url) => {
        if (String(url).endsWith("/api/parse-jd")) return json({ jd: {} });
        if (String(url).endsWith("/api/analyze")) return json({ analysis: {}, remaining: 4 });
        if (String(url).endsWith("/api/rescore")) return json({ error: "Unknown run." }, 403);
        return json({ tailored: { projected_match_score: 80 }, remaining: 4 });
      }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { patches, onUpdate } = collect();
    await runTailor(JD, RESUME, onUpdate);

    // A completed, CHARGED result must not be thrown away because a cosmetic
    // follow-up failed. The panel keeps the tailor model's own projection.
    expect(patches.at(-1)?.phase).toBe("done");
    // The "reading" patch nulls this field on purpose, so the check is that
    // no patch ever delivers a VALUE.
    expect(patches.some((p) => p.rescoredScore != null)).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it("ignores a 200 whose body carries no numeric score", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (url) => {
        if (String(url).endsWith("/api/parse-jd")) return json({ jd: {} });
        if (String(url).endsWith("/api/analyze")) return json({ analysis: {}, remaining: 4 });
        if (String(url).endsWith("/api/rescore")) return json({ score: "88" });
        return json({ tailored: { projected_match_score: 80 }, remaining: 4 });
      }),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { patches, onUpdate } = collect();
    await runTailor(JD, RESUME, onUpdate);

    // apiPost casts without checking, so an unvalidated body would put a
    // string (or undefined) where the type promises a number.
    // The "reading" patch nulls this field on purpose, so the check is that
    // no patch ever delivers a VALUE.
    expect(patches.some((p) => p.rescoredScore != null)).toBe(false);
    expect(patches.at(-1)?.phase).toBe("done");
  });

  it("clears a previous run's rescored score when a new run starts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => json({ jd: {} })),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { patches, onUpdate } = collect();
    await runTailor(JD, RESUME, onUpdate);
    expect(patches[0]).toMatchObject({ phase: "reading", rescoredScore: null });
  });

  // The run above also exercises it, but state it directly: a tailor response
  // this module cannot read must not become a failed run. background/runs.ts
  // turns any exception out of runTailor into `phase: "error"`, which would
  // discard a result the caller was already charged for.
  it("survives a tailor body with no resume rather than throwing out of the run", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (url) => {
        if (String(url).endsWith("/api/parse-jd")) return json({ jd: {} });
        if (String(url).endsWith("/api/analyze")) return json({ analysis: {}, remaining: 4 });
        return json({ tailored: null, remaining: 4 });
      }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { patches, onUpdate } = collect();

    await expect(runTailor(JD, RESUME, onUpdate)).resolves.toBeUndefined();

    expect(patches.at(-1)?.phase).toBe("done");
    expect(warn).toHaveBeenCalled();
  });
});
