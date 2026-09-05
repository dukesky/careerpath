import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runTailor, type RunState } from "@/lib/run";
import type { GapAnalysis, ParsedResume } from "@shared/contract";
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
    // Five legs now: analyze, tailor, rescore, and the auto-refine pair
    // (tailor again, rescore again). Every one of them carries the SAME id —
    // not incidental: the server's marker gate refuses a runId it has never
    // seen charged, so a rescore sent under a fresh id would 403 on every run,
    // and a refine tailor under a fresh id would be charged as a new run.
    expect(ids).toEqual([
      "reused-id",
      "reused-id",
      "reused-id",
      "reused-id",
      "reused-id",
    ]);
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
    // analyze, tailor, and the auto-refine tailor: the rewrite leg must not
    // drop the supplement, or the refined resume would lose the experience the
    // user typed in and score worse for it.
    expect(sent).toEqual([
      "I used PyTorch on X",
      "I used PyTorch on X",
      "I used PyTorch on X",
    ]);

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

  // Pins the high-risk requirement from the brief: EVERY apiPost call —
  // parse-jd, analyze, tailor, rescore, and the auto-refine tailor/rescore
  // pair — must carry the run token, not just the two that happen to run in
  // parallel. Dropping any one of them sends that leg as a device caller with
  // nothing visibly wrong in the UI, and for rescore specifically the symptom
  // is a 403 from the marker gate (the run was charged to the user, so no
  // marker exists under the device key).
  it("sends the runToken as the bearer identity on every leg", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith("/api/parse-jd")) return json({ jd: {} });
      if (String(url).endsWith("/api/analyze")) return json({ analysis: {}, remaining: 4 });
      if (String(url).endsWith("/api/rescore")) return json({ score: 81 });
      return json({ tailored: {}, remaining: 4 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await runTailor(JD, RESUME, () => {}, { runToken: "run-token-xyz" });

    // parse-jd, analyze, tailor, rescore, refine-tailor, refine-rescore.
    expect(fetchMock).toHaveBeenCalledTimes(6);
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

    // The auto-refine leg repeats the measurement, so there are two of each —
    // but the FIRST thing in the list is still the done patch, and no request
    // precedes it. That is the invariant this test exists for.
    expect(order).toEqual([
      "done-patch",
      "rescore-request",
      "rescore-patch",
      "rescore-request",
      "rescore-patch",
    ]);
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

    // The measurement patch carries the score and NOTHING else. No phase: the
    // run was already `done` and re-sending it is the only way this patch
    // could disturb what is on screen.
    const scorePatch = patches.find((p) => p.rescoredScore != null);
    expect(scorePatch).toEqual({ rescoredScore: 88 });
    // The auto-refine leg's closing patch follows it, and is equally
    // phase-free. Here the refined rewrite measures 88 again — not worse — so
    // it is adopted alongside the flag that closes the leg, and with the
    // refine call's own quota read (the same 4 the done patch published, since
    // the free leg does not charge).
    expect(patches.at(-1)).toEqual({
      tailored: { projected_match_score: 80 },
      rescoredScore: 88,
      remaining: 4,
      refining: false,
    });
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
    // The auto-refine leg's `refining:false` patch is last and carries no
    // phase, so read the last patch that reports one — and check no patch
    // ever reported `error`.
    expect(patches.filter((p) => p.phase).at(-1)?.phase).toBe("done");
    expect(patches.some((p) => p.phase === "error")).toBe(false);
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
    // Last patch is the auto-refine leg's phase-free `refining:false`, so read
    // the last patch that reports a phase.
    expect(patches.filter((p) => p.phase).at(-1)?.phase).toBe("done");
    // An unreadable rescore body is cosmetic: the run the user was charged for
    // must never be reported as failed on the way to `done` either.
    expect(patches.some((p) => p.phase === "error")).toBe(false);
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

    expect(patches.filter((p) => p.phase).at(-1)?.phase).toBe("done");
    expect(patches.some((p) => p.phase === "error")).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  // ------------------------------------------------------------ auto-refine
  //
  // The free second leg: once the first measurement is in, tailor again WITH
  // the gap analysis under the same runId (so the server treats it as a free
  // refinement), measure the rewrite, and adopt it only when the measured
  // number is not worse. Everything here happens strictly after the `done`
  // patch, so it can only improve a number already on screen.

  it("auto-refines after the first rescore: tailor with analysis, rescore again, adopt when not worse", async () => {
    const tailorBodies: Record<string, unknown>[] = [];
    let tailorCalls = 0;
    let rescoreCalls = 0;
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const u = String(url);
      if (u.endsWith("/api/parse-jd")) return json({ jd: { company: "Acme" } });
      if (u.endsWith("/api/analyze"))
        return json({ analysis: { overall_match_score: 60, requirements_matrix: [] }, remaining: 4 });
      if (u.endsWith("/api/tailor")) {
        tailorCalls += 1;
        tailorBodies.push(JSON.parse(String(init?.body)));
        // The refine leg's read is LOWER than the done patch's: the charge for
        // this run committed after the first two reads answered.
        return json({
          tailored: { projected_match_score: 70, resume: { summary: `v${tailorCalls}` } },
          remaining: tailorCalls === 1 ? 4 : 3,
        });
      }
      // /api/rescore: first measurement 65, refined measurement 72
      rescoreCalls += 1;
      return json({ score: rescoreCalls === 1 ? 65 : 72 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { patches, onUpdate } = collect();
    await runTailor(JD, RESUME, onUpdate);

    expect(tailorCalls).toBe(2);
    expect(rescoreCalls).toBe(2);
    // The refine tailor call carries the analysis; the first one does not.
    expect(tailorBodies[0].analysis).toBeUndefined();
    expect(tailorBodies[1].analysis).toEqual({ overall_match_score: 60, requirements_matrix: [] });
    // Refined result adopted with its measured score.
    const final = patches[patches.length - 1];
    expect(final.tailored).toMatchObject({ resume: { summary: "v2" } });
    expect(final.rescoredScore).toBe(72);
    // The refine leg's own quota read is published with the adoption rather
    // than discarded — it is the freshest count there is, and the done patch's
    // 4 was taken before this run's charge committed. Min-ed, so it can only
    // go down.
    expect(patches.filter((p) => p.remaining !== undefined).at(-1)?.remaining).toBe(3);
    // refining toggled on then off around the refine leg.
    expect(patches.some((p) => p.refining === true)).toBe(true);
    expect(patches[patches.length - 1].refining).toBe(false);
  });

  it("discards a refined rewrite that measures WORSE than the first rescore", async () => {
    let rescoreCalls = 0;
    let tailorCalls = 0;
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      const u = String(url);
      if (u.endsWith("/api/parse-jd")) return json({ jd: {} });
      if (u.endsWith("/api/analyze"))
        return json({ analysis: { overall_match_score: 60 }, remaining: 4 });
      if (u.endsWith("/api/tailor")) {
        tailorCalls += 1;
        return json({ tailored: { projected_match_score: 70, resume: { summary: `v${tailorCalls}` } }, remaining: 4 });
      }
      rescoreCalls += 1;
      return json({ score: rescoreCalls === 1 ? 65 : 58 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { patches, onUpdate } = collect();
    await runTailor(JD, RESUME, onUpdate);

    // Worse measurement: keep v1 and 65 on screen; only `refining:false` published after.
    const withTailored = patches.filter((p) => p.tailored);
    expect(withTailored[withTailored.length - 1].tailored).toMatchObject({ resume: { summary: "v1" } });
    expect(patches.filter((p) => typeof p.rescoredScore === "number").pop()?.rescoredScore).toBe(65);
  });

  it("skips the auto-refine on a run that carries priorAnalysis, and sends it to tailor", async () => {
    const tailorBodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const u = String(url);
      if (u.endsWith("/api/parse-jd")) return json({ jd: {} });
      if (u.endsWith("/api/analyze"))
        return json({ analysis: { overall_match_score: 60 }, remaining: 4 });
      if (u.endsWith("/api/tailor")) {
        tailorBodies.push(JSON.parse(String(init?.body)));
        return json({ tailored: { projected_match_score: 70 }, remaining: 4 });
      }
      return json({ score: 66 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const prior = { overall_match_score: 55, requirements_matrix: [] } as unknown as GapAnalysis;
    await runTailor(JD, RESUME, () => {}, { runId: "reused-id", priorAnalysis: prior });

    expect(tailorBodies).toHaveLength(1);
    expect(tailorBodies[0].analysis).toEqual(prior);
    // Exactly one rescore fired (the initial measurement) — no auto-refine legs.
    const rescoreHits = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/api/rescore"));
    expect(rescoreHits).toHaveLength(1);
  });

  // `priorAnalysis` alone cannot carry the skip: a refine run whose previous
  // entry has no usable analysis still reuses the runId, and is still itself
  // the second free leg. Letting the tail fire there sends the runId's FOURTH
  // rescore (429), produces a rewrite that can never be adopted, and burns the
  // sixth free leg so the NEXT refine is charged. The flag says "this run is a
  // refinement" independently of what it had to aim at.
  it("skips the auto-refine on a refinement even with no priorAnalysis to send", async () => {
    const tailorBodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const u = String(url);
      if (u.endsWith("/api/parse-jd")) return json({ jd: {} });
      if (u.endsWith("/api/analyze"))
        return json({ analysis: { overall_match_score: 60 }, remaining: 4 });
      if (u.endsWith("/api/tailor")) {
        tailorBodies.push(JSON.parse(String(init?.body)));
        return json({ tailored: { projected_match_score: 70 }, remaining: 4 });
      }
      return json({ score: 66 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await runTailor(JD, RESUME, () => {}, { runId: "reused-id", isRefinement: true });

    expect(tailorBodies).toHaveLength(1);
    // Nothing to aim at, so nothing is sent — but the tail is still skipped.
    expect(tailorBodies[0].analysis).toBeUndefined();
    const rescoreHits = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/api/rescore"));
    expect(rescoreHits).toHaveLength(1);
  });
});
