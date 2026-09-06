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

const encoder = new TextEncoder();

function stream(frames: string[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

/**
 * What /api/analyze and /api/tailor answer now: text deltas, then the same
 * body the buffered call would have returned, then [DONE].
 */
const sse = (final: unknown, deltas: string[] = []) =>
  stream([
    ...deltas.map((d) => `data: ${JSON.stringify({ d })}\n\n`),
    `data: ${JSON.stringify({ final })}\n\n`,
    "data: [DONE]\n\n",
  ]);

/** A stream that stops mid-JSON: deltas, then the socket closes. */
const brokenSse = (deltas: string[]) =>
  stream(deltas.map((d) => `data: ${JSON.stringify({ d })}\n\n`));

/**
 * A broken stream held shut until `gate` resolves.
 *
 * The two model legs run in parallel, so one of them is always still writing
 * when the other ends the run. This is how a test puts that leg's deltas
 * strictly AFTER the terminal patch instead of racing them.
 */
const gatedSse = (gate: Promise<void>, deltas: string[]) =>
  new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        await gate;
        for (const d of deltas) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ d })}\n\n`));
        }
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );

/**
 * Let the work runTailor left floating finish.
 *
 * A run that fails at analyze RETURNS while the tailor leg is still in flight
 * — deliberately, since awaiting it would delay the error the user is waiting
 * for. Anything that leg still does happens after `await runTailor` resolves,
 * so a test about it has to drain the queue first.
 */
const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

function collect() {
  const patches: Partial<RunState>[] = [];
  return { patches, onUpdate: (p: Partial<RunState>) => patches.push(p) };
}

const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body));

/**
 * Every delta opens the throttle window. The 500ms floor is real behaviour
 * (see the throttle test below), but a test that wants to watch the paint
 * progress has to let each delta through.
 */
function everyDeltaPaints() {
  let clock = 100_000;
  vi.spyOn(Date, "now").mockImplementation(() => (clock += 600));
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
      if (String(url).endsWith("/api/analyze"))
        return sse({ analysis: { overall_match_score: 70 }, remaining: 4 });
      if (String(url).endsWith("/api/tailor"))
        return sse({ tailored: { projected_match_score: 85 }, remaining: 4 });
      return json({ score: 80 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { onUpdate } = collect();
    await runTailor(JD, RESUME, onUpdate);

    const byUrl = new Map(
      fetchMock.mock.calls.map((c) => [String(c[0]), bodyOf(c)]),
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
        if (String(url).endsWith("/api/analyze")) return sse({ analysis: {}, remaining: 3 });
        if (String(url).endsWith("/api/tailor")) return sse({ tailored: {}, remaining: 3 });
        return json({ score: 70 });
      }),
    );
    await runTailor(JD, RESUME, () => {});
    await runTailor(JD, RESUME, () => {});
    expect(new Set(seen).size).toBe(2);
  });

  // The serial parse hop is gone: the posting text the content script already
  // extracted goes straight to both model legs. A reinstated /api/parse-jd
  // would put a 3-8s round trip back in front of every run's first paint.
  it("never calls /api/parse-jd, and sends the raw jdText to every leg", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith("/api/analyze")) return sse({ analysis: {}, remaining: 4 });
      if (String(url).endsWith("/api/tailor"))
        return sse({ tailored: { resume: { summary: "v1" } }, remaining: 4 });
      return json({ score: 80 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await runTailor(JD, RESUME, () => {});

    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("parse-jd"))).toBe(false);
    // analyze, tailor, rescore — and every one of them carries the JD as text.
    expect(urls).toHaveLength(3);
    for (const call of fetchMock.mock.calls) {
      const body = bodyOf(call);
      expect(body.jdText).toBe(JD.text);
      expect(body.structuredJD).toBeUndefined();
    }
  });

  // The server caps the posting at MAX_JD_CHARS before it reaches a model, so
  // everything past that is bytes uploaded to be thrown away. A long posting
  // page (or a mis-extracted whole document) is not rare enough to leave that
  // to the wire.
  it("caps the jdText it uploads on every leg", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith("/api/analyze")) return sse({ analysis: {}, remaining: 4 });
      if (String(url).endsWith("/api/tailor"))
        return sse({ tailored: { resume: { summary: "v1" } }, remaining: 4 });
      return json({ score: 80 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const long = { ...JD, text: "b".repeat(25_000) };
    await runTailor(long, RESUME, () => {});

    expect(fetchMock.mock.calls).toHaveLength(3); // analyze, tailor, rescore
    for (const call of fetchMock.mock.calls) {
      expect(bodyOf(call).jdText).toBe("b".repeat(10_000));
    }
  });

  it("asks the two model legs to stream, and the rescore leg not to", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith("/api/analyze")) return sse({ analysis: {}, remaining: 4 });
      if (String(url).endsWith("/api/tailor")) return sse({ tailored: {}, remaining: 4 });
      return json({ score: 80 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await runTailor(JD, RESUME, () => {});

    const streamFlag = (path: string) =>
      bodyOf(fetchMock.mock.calls.find((c) => String(c[0]).endsWith(path))!).stream;
    expect(streamFlag("/api/analyze")).toBe(true);
    expect(streamFlag("/api/tailor")).toBe(true);
    // Nothing renders a rescore in progress — it is one number, published once.
    expect(streamFlag("/api/rescore")).toBeUndefined();
  });

  it("reports analysis before the tailored result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("/api/analyze"))
          return sse({ analysis: { overall_match_score: 61 }, remaining: 2 });
        if (String(url).endsWith("/api/rescore")) return json({ score: 83 });
        return sse({ tailored: { projected_match_score: 80 }, remaining: 2 });
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
      vi.fn(async () => json({ error: "You've used all your free runs." }, 402)),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { patches, onUpdate } = collect();
    await runTailor(JD, RESUME, onUpdate);
    expect(patches.at(-1)?.phase).toBe("error");
    expect(patches.at(-1)?.error?.kind).toBe("quota");
  });

  it("reports the lower remaining when the two legs disagree", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (url) => {
        if (String(url).endsWith("/api/analyze")) return sse({ analysis: {}, remaining: 2 });
        if (String(url).endsWith("/api/rescore")) return json({ score: 77 });
        return sse({ tailored: {}, remaining: 3 });
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
      if (String(url).endsWith("/api/analyze")) return sse({ analysis: {}, remaining: 4 });
      if (String(url).endsWith("/api/tailor")) return sse({ tailored: {}, remaining: 4 });
      return json({ score: 80 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await runTailor(JD, RESUME, () => {}, { runId: "reused-id" });

    const ids = fetchMock.mock.calls.map((c) => bodyOf(c).runId);
    // Three legs by default: analyze, tailor, rescore. Every one of them
    // carries the SAME id — not incidental: the server's marker gate refuses a
    // runId it has never seen charged, so a rescore sent under a fresh id
    // would 403 on every run.
    expect(ids).toEqual(["reused-id", "reused-id", "reused-id"]);
  });

  it("sends the supplement to both analyze and tailor", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith("/api/analyze")) return sse({ analysis: {}, remaining: 4 });
      if (String(url).endsWith("/api/tailor")) return sse({ tailored: {}, remaining: 4 });
      return json({ score: 80 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await runTailor(JD, RESUME, () => {}, { extraInfo: "I used PyTorch on X" });

    const sent = fetchMock.mock.calls
      .filter((c) => /api\/(analyze|tailor)$/.test(String(c[0])))
      .map((c) => bodyOf(c).extraInfo);
    // analyze and tailor — the two legs a default run makes. Neither may drop
    // the supplement, or the tailored resume would lose the experience the
    // user typed in and score worse for it.
    expect(sent).toEqual(["I used PyTorch on X", "I used PyTorch on X"]);

    // ...and NOT to rescore, deliberately. Rescore measures the TAILORED
    // resume, which has already absorbed the supplement; re-declaring the same
    // facts as "experience not on the resume" would count them twice.
    const rescoreBody = bodyOf(
      fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/api/rescore"))!,
    );
    expect(rescoreBody.extraInfo).toBeUndefined();
  });

  // Pins the high-risk requirement from the brief: EVERY call — analyze,
  // tailor, rescore, and (when the gated auto-refine leg runs) its
  // tailor/rescore pair — must carry the run token, not just the two that
  // happen to run in parallel. Dropping any one of them sends that leg as a
  // device caller with nothing visibly wrong in the UI, and for rescore
  // specifically the symptom is a 403 from the marker gate (the run was
  // charged to the user, so no marker exists under the device key). The
  // streamed legs are no exception: apiStream travels through the same
  // identity fork apiPost does.
  it("sends the runToken as the bearer identity on every leg", async () => {
    let tailorCalls = 0;
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith("/api/analyze")) return sse({ analysis: {}, remaining: 4 });
      if (String(url).endsWith("/api/tailor")) {
        tailorCalls += 1;
        // The auto-refine leg is buffered, not streamed — see the leg's own
        // tests below.
        return tailorCalls === 1
          ? sse({ tailored: {}, remaining: 4 })
          : json({ tailored: {}, remaining: 4 });
      }
      return json({ score: 81 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const bearersAreSet = () => {
      for (const call of fetchMock.mock.calls) {
        const init = call[1] as RequestInit;
        expect((init.headers as Record<string, string>).Authorization).toBe(
          "Bearer run-token-xyz",
        );
      }
    };

    await runTailor(JD, RESUME, () => {}, { runToken: "run-token-xyz" });
    // The default run: analyze, tailor, rescore. The parse hop is gone.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    bearersAreSet();

    // ...and the gated auto-refine pair, which is where this is easiest to
    // forget, since those two calls are made from a different block.
    fetchMock.mockClear();
    tailorCalls = 0;
    await runTailor(JD, RESUME, () => {}, { runToken: "run-token-xyz", autoRefine: true });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    bearersAreSet();
  });

  // ---------------------------------------------------------------- streaming
  //
  // Presentation only. Everything below may make first paint arrive sooner;
  // nothing below may decide whether the run succeeds. The buffered fallback
  // test is the load-bearing one.

  it("paints the score, then the matrix rows, before the analysis itself lands", async () => {
    everyDeltaPaints();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (url) => {
        if (String(url).endsWith("/api/analyze"))
          return sse(
            {
              analysis: { overall_match_score: 71, requirements_matrix: [] },
              remaining: 4,
            },
            [
              '{"overall_match_score": 71, "rationale": "Solid",',
              ' "requirements_matrix": [{"requirement":"Go","kind":"must_have",' +
                '"status":"met","evidence":"e","suggestion":""},',
              '{"requirement":"K8s","kind":"nice","status":"partial",' +
                '"evidence":"","suggestion":"s"}]}',
            ],
          );
        if (String(url).endsWith("/api/tailor")) return sse({ tailored: {}, remaining: 4 });
        return json({ score: 80 });
      }),
    );

    const { patches, onUpdate } = collect();
    await runTailor(JD, RESUME, onUpdate);

    const scoreAt = patches.findIndex((p) => p.streamingScore === 71);
    const analysisAt = patches.findIndex((p) => "analysis" in p && p.analysis);
    expect(scoreAt).toBeGreaterThanOrEqual(0);
    // The point of the whole change: a number on screen before the model has
    // finished writing the matrix behind it.
    expect(analysisAt).toBeGreaterThan(scoreAt);

    // Rows arrive one at a time and only ever grow.
    const rowCounts = patches
      .filter((p) => p.streamingRows !== undefined && p.streamingRows.length > 0)
      .map((p) => p.streamingRows!.length);
    expect(rowCounts).toEqual([1, 2]);
    // Coerced with the server's own semantics, so a row does not change when
    // the final frame replaces it: "nice"/"partial" are not raw enum values.
    const lastRows = patches.filter((p) => p.streamingRows?.length === 2).at(-1)!.streamingRows!;
    expect(lastRows[1]).toEqual({
      requirement: "K8s",
      kind: "nice_to_have",
      status: "partially_met",
      evidence: "",
      suggestion: "s",
    });
  });

  it("paints the tailored summary and experience as they arrive", async () => {
    everyDeltaPaints();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (url) => {
        if (String(url).endsWith("/api/analyze")) return sse({ analysis: {}, remaining: 4 });
        if (String(url).endsWith("/api/tailor"))
          return sse({ tailored: { resume: { summary: "Backend engineer." } }, remaining: 4 }, [
            '{"resume": {"summary": "Backend engineer.",',
            ' "experience": [{"company":"Acme","title":"SRE","dates":"2020",' +
              '"bullets":["Ran Go services"]}',
            "]}}",
          ]);
        return json({ score: 80 });
      }),
    );

    const { patches, onUpdate } = collect();
    await runTailor(JD, RESUME, onUpdate);

    const previews = patches
      .map((p) => p.streamingResume)
      .filter((r): r is NonNullable<typeof r> => !!r);
    expect(previews[0].summary).toBe("Backend engineer.");
    expect(previews.at(-1)?.experience).toEqual([
      { company: "Acme", title: "SRE", dates: "2020", bullets: ["Ran Go services"] },
    ]);
    // A preview, not a result: the sections the stream has not reached are
    // empty rather than invented.
    expect(previews.at(-1)?.contact.name).toBe("");
    expect(previews.at(-1)?.skills).toEqual([]);
  });

  // Terminal patches describe terminal state completely — App.tsx resets state
  // on a JD URL change, so a done patch that left these set would strand a
  // half-written preview beside a finished result.
  it("clears every streaming field in the done patch", async () => {
    everyDeltaPaints();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (url) => {
        if (String(url).endsWith("/api/analyze"))
          return sse({ analysis: { overall_match_score: 71 }, remaining: 4 }, [
            '{"overall_match_score": 71,',
          ]);
        if (String(url).endsWith("/api/tailor"))
          return sse({ tailored: { resume: { summary: "s" } }, remaining: 4 }, [
            '{"resume":{"summary":"s",',
          ]);
        return json({ score: 80 });
      }),
    );

    const { patches, onUpdate } = collect();
    await runTailor(JD, RESUME, onUpdate);

    // The preview really was published, so the clearing below is not vacuous.
    expect(patches.some((p) => p.streamingScore === 71)).toBe(true);
    const done = patches.find((p) => p.phase === "done")!;
    expect(done).toMatchObject({
      streamingScore: null,
      streamingRows: [],
      streamingResume: null,
    });
  });

  it("clears every streaming field in the error patch too", async () => {
    everyDeltaPaints();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (url, init) => {
        const streamed = JSON.parse(String(init?.body)).stream === true;
        if (String(url).endsWith("/api/analyze")) {
          // The stream paints, then the leg fails — and the buffered fallback
          // fails too, so the run really does end in error.
          return streamed
            ? brokenSse(['{"overall_match_score": 44,'])
            : json({ error: "Analysis failed: upstream down" }, 502);
        }
        if (String(url).endsWith("/api/tailor")) return sse({ tailored: {}, remaining: 4 });
        return json({ score: 80 });
      }),
    );

    const { patches, onUpdate } = collect();
    await runTailor(JD, RESUME, onUpdate);

    expect(patches.some((p) => p.streamingScore === 44)).toBe(true);
    const errorPatch = patches.at(-1)!;
    expect(errorPatch.phase).toBe("error");
    expect(errorPatch).toMatchObject({
      streamingScore: null,
      streamingRows: [],
      streamingResume: null,
    });
    // The copy is the buffered path's, prefix and all — the streamed error
    // frame carries a bare message and never reaches the user.
    expect(errorPatch.error?.message).toBe("Analysis failed: upstream down");
  });

  // THE rule for this whole change: streaming may only make a result arrive
  // sooner. A stream that dies takes the leg back to the buffered request the
  // product shipped with, under the SAME runId so the server dedupes the
  // charge, and the user sees a completed run.
  it("falls back to one buffered request when a stream breaks, and still completes", async () => {
    everyDeltaPaints();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const streamed = JSON.parse(String(init?.body)).stream === true;
      if (String(url).endsWith("/api/analyze")) {
        return streamed
          ? brokenSse(['{"overall_match_score": 64,'])
          : json({ analysis: { overall_match_score: 64 }, remaining: 4 });
      }
      if (String(url).endsWith("/api/tailor")) return sse({ tailored: { resume: {} }, remaining: 4 });
      return json({ score: 80 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { patches, onUpdate } = collect();
    await runTailor(JD, RESUME, onUpdate);

    const analyzeCalls = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/api/analyze"));
    // Exactly one retry, and it is the buffered shape.
    expect(analyzeCalls).toHaveLength(2);
    expect(bodyOf(analyzeCalls[1]).stream).toBeUndefined();
    // Same runId on both, or the server would charge the leg twice.
    expect(bodyOf(analyzeCalls[1]).runId).toBe(bodyOf(analyzeCalls[0]).runId);
    // The leg that did NOT break is not retried.
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/api/tailor"))).toHaveLength(1);

    expect(patches.some((p) => p.phase === "error")).toBe(false);
    const done = patches.find((p) => p.phase === "done")!;
    expect(done.analysis).toEqual({ overall_match_score: 64 });
  });

  it("does not retry a leg whose stream succeeded", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith("/api/analyze")) return sse({ analysis: {}, remaining: 4 });
      if (String(url).endsWith("/api/tailor")) return sse({ tailored: {}, remaining: 4 });
      return json({ score: 80 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await runTailor(JD, RESUME, () => {});

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  // A terminal patch ends the run for everyone, including the leg that did not
  // fail. That leg is still streaming — its onDelta closure still holds
  // `onUpdate`, and background/runs.ts merges whatever it publishes into the
  // stored live run — so without a liveness check a dead run keeps painting a
  // preview over a failed (or, after App.tsx's cache restore, a finished)
  // result, and then pays for a buffered retry of a leg nothing will read.
  it("stops painting, and stops spending, once the sibling leg has failed the run", async () => {
    everyDeltaPaints();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let openTailor!: () => void;
    const tailorGate = new Promise<void>((resolve) => {
      openTailor = resolve;
    });

    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const streamed = JSON.parse(String(init?.body)).stream === true;
      if (String(url).endsWith("/api/analyze")) {
        // Stream dies, buffered fallback fails: the run really ends here.
        return streamed
          ? brokenSse(['{"overall_match_score": 44,'])
          : json({ error: "Analysis failed: upstream down" }, 502);
      }
      if (String(url).endsWith("/api/tailor")) {
        // Every one of these deltas — the same shape that paints a preview in
        // the tests above — arrives at a run that is already over.
        return gatedSse(tailorGate, ['{"resume":{"summary":"still writing",', ' "experience": []']);
      }
      return json({ score: 80 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { patches, onUpdate } = collect();
    await runTailor(JD, RESUME, onUpdate);

    // The analyze leg did paint before it died, so "nothing paints after this"
    // is a claim about the guard, not about a stream that never ran.
    expect(patches.some((p) => p.streamingScore === 44)).toBe(true);
    const terminalAt = patches.length - 1;
    expect(patches[terminalAt].phase).toBe("error");

    openTailor();
    await flush();

    // Nothing at all follows the terminal patch.
    expect(patches).toHaveLength(terminalAt + 1);
    expect(patches.slice(terminalAt + 1).some((p) => p.streamingResume)).toBe(false);
    // ...and the dead run's tailor leg does not buy itself a buffered retry.
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/api/tailor"))).toHaveLength(1);
  });

  // The buffered fallback exists for a stream that BROKE. A refusal — no quota
  // left, session gone, rate limited — is the server's considered answer, and
  // re-sending it turns one refused run into four requests while each 429
  // retry digs the rate-limit hole deeper.
  it("does not re-send a refusal: a 402 costs one request per leg, not two", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn<typeof fetch>(async () =>
      json({ error: "You've used all your free runs." }, 402),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { patches, onUpdate } = collect();
    await runTailor(JD, RESUME, onUpdate);
    await flush();

    expect(
      fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/api/analyze")),
    ).toHaveLength(1);
    // Two legs, one request each, and nothing after them.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(patches.at(-1)?.phase).toBe("error");
    expect(patches.at(-1)?.error?.kind).toBe("quota");
  });

  // A run that dies at analyze must not go on to spend the legs that follow
  // it. The rescore in particular is an analyze-grade model call, and there is
  // no tailored resume to measure.
  it("issues no further LLM legs after the first one fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith("/api/analyze")) return json({ error: "Upstream down" }, 500);
      if (String(url).endsWith("/api/tailor")) return sse({ tailored: { resume: {} }, remaining: 4 });
      return json({ score: 80 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { patches, onUpdate } = collect();
    await runTailor(JD, RESUME, onUpdate);
    await flush();

    const hits = (path: string) =>
      fetchMock.mock.calls.filter((c) => String(c[0]).endsWith(path)).length;
    // A 500 IS a transport failure, so analyze gets its one buffered retry.
    expect(hits("/api/analyze")).toBe(2);
    // The tailor stream succeeded on its own, so it is never re-sent...
    expect(hits("/api/tailor")).toBe(1);
    // ...and nothing downstream of the failure runs at all.
    expect(hits("/api/rescore")).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(patches.at(-1)?.phase).toBe("error");
  });

  // Each patch is a chrome.storage write in the service worker (see
  // background/runs.ts), and a model emits tokens far faster than storage can
  // absorb writes. The floor is what keeps a streamed run from flooding it.
  it("publishes at most one streaming patch per 500ms window", async () => {
    vi.spyOn(Date, "now").mockReturnValue(500_000); // one frozen window
    const deltas = ['{"overall_match_score": 70, "requirements_matrix": ['];
    for (let i = 0; i < 50; i++) {
      deltas.push(
        `{"requirement":"r${i}","kind":"must_have","status":"met","evidence":"","suggestion":""},`,
      );
    }
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (url) => {
        if (String(url).endsWith("/api/analyze"))
          return sse({ analysis: { overall_match_score: 70 }, remaining: 4 }, deltas);
        if (String(url).endsWith("/api/tailor")) return sse({ tailored: {}, remaining: 4 });
        return json({ score: 80 });
      }),
    );

    const { patches, onUpdate } = collect();
    await runTailor(JD, RESUME, onUpdate);

    // 51 deltas, one window: one paint. (The reading and done patches also
    // carry these fields — as nulls — so count only the ones with a value.)
    const painted = patches.filter(
      (p) => p.streamingScore != null || (p.streamingRows?.length ?? 0) > 0,
    );
    expect(painted).toHaveLength(1);
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
        if (String(url).endsWith("/api/analyze")) return sse({ analysis: {}, remaining: 4 });
        if (String(url).endsWith("/api/rescore")) {
          order.push("rescore-request");
          return json({ score: 88 });
        }
        return sse({ tailored: { projected_match_score: 80 }, remaining: 4 });
      }),
    );

    await runTailor(JD, RESUME, (patch) => {
      if (patch.phase === "done") order.push("done-patch");
      // `!= null` skips the "reading" patch, which nulls this field to clear
      // the previous run's value.
      if (patch.rescoredScore != null) order.push("rescore-patch");
    });

    // The FIRST thing in the list is the done patch, and no request precedes
    // it. That is the invariant this test exists for.
    expect(order).toEqual(["done-patch", "rescore-request", "rescore-patch"]);
  });

  it("sends the TAILORED resume to rescore, not the original", async () => {
    const tailoredResume = { contact: { name: "Ada (tailored)" }, summary: "rewritten" };
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith("/api/analyze")) return sse({ analysis: {}, remaining: 4 });
      if (String(url).endsWith("/api/rescore")) return json({ score: 88 });
      return sse({
        tailored: { resume: tailoredResume, projected_match_score: 80 },
        remaining: 4,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await runTailor(JD, RESUME, () => {});

    const body = bodyOf(
      fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/api/rescore"))!,
    );
    // Measuring the ORIGINAL here would produce a second, more expensive copy
    // of the number already on the left and render "72 → 72" on every run.
    expect(body.structuredResume).toEqual(tailoredResume);
    // The same JD the other two legs measured against, in the only form this
    // run has: the raw posting. A rescore against a different JD is not the
    // same ruler.
    expect(body.jdText).toBe(JD.text);
  });

  it("publishes the rescored score with the phase still done", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (url) => {
        if (String(url).endsWith("/api/analyze")) return sse({ analysis: {}, remaining: 4 });
        if (String(url).endsWith("/api/rescore")) return json({ score: 88 });
        return sse({ tailored: { projected_match_score: 80 }, remaining: 4 });
      }),
    );
    const { patches, onUpdate } = collect();
    await runTailor(JD, RESUME, onUpdate);

    // The measurement patch carries the score and NOTHING else. No phase: the
    // run was already `done` and re-sending it is the only way this patch
    // could disturb what is on screen.
    const scorePatch = patches.find((p) => p.rescoredScore != null);
    expect(scorePatch).toEqual({ rescoredScore: 88 });
    // With the auto-refine leg off by default, that measurement patch is also
    // the LAST thing the run publishes.
    expect(patches.at(-1)).toEqual({ rescoredScore: 88 });
  });

  it("leaves the run done — never error — when the rescore fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (url) => {
        if (String(url).endsWith("/api/analyze")) return sse({ analysis: {}, remaining: 4 });
        if (String(url).endsWith("/api/rescore")) return json({ error: "Unknown run." }, 403);
        return sse({ tailored: { projected_match_score: 80 }, remaining: 4 });
      }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { patches, onUpdate } = collect();
    await runTailor(JD, RESUME, onUpdate);

    // A completed, CHARGED result must not be thrown away because a cosmetic
    // follow-up failed. The panel keeps the tailor model's own projection.
    // The measurement patch that follows `done` carries no phase, so read the
    // last patch that reports one — and check no patch ever reported `error`.
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
        if (String(url).endsWith("/api/analyze")) return sse({ analysis: {}, remaining: 4 });
        if (String(url).endsWith("/api/rescore")) return json({ score: "88" });
        return sse({ tailored: { projected_match_score: 80 }, remaining: 4 });
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
    // Patches published after `done` are phase-free, so read the last patch
    // that reports a phase.
    expect(patches.filter((p) => p.phase).at(-1)?.phase).toBe("done");
    // An unreadable rescore body is cosmetic: the run the user was charged for
    // must never be reported as failed on the way to `done` either.
    expect(patches.some((p) => p.phase === "error")).toBe(false);
  });

  it("clears a previous run's rescored score when a new run starts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => json({ error: "nope" }, 500)),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { patches, onUpdate } = collect();
    await runTailor(JD, RESUME, onUpdate);
    expect(patches[0]).toMatchObject({
      phase: "reading",
      rescoredScore: null,
      // Same rule, same patch: a regenerate must not leave the previous run's
      // half-written preview on screen either.
      streamingScore: null,
      streamingRows: [],
      streamingResume: null,
    });
  });

  // The run above also exercises it, but state it directly: a tailor response
  // this module cannot read must not become a failed run. background/runs.ts
  // turns any exception out of runTailor into `phase: "error"`, which would
  // discard a result the caller was already charged for.
  it("survives a tailor body with no resume rather than throwing out of the run", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (url) => {
        if (String(url).endsWith("/api/analyze")) return sse({ analysis: {}, remaining: 4 });
        if (String(url).endsWith("/api/tailor")) return sse({ tailored: null, remaining: 4 });
        // What the server answers when the rescore leg is handed the resume
        // that was not in that body: a 400, which must warn and change
        // nothing else.
        return json({ error: "Missing structuredResume." }, 400);
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
  //
  // It is OPT-IN (`autoRefine: true`) and nothing in the product turns it on —
  // see the default test immediately below, which is the one that matters for
  // shipped behavior. The bench evidence is that this leg improves
  // blind-judged document quality but not the measured score, while spending
  // the runId's second free leg and doubling per-IP quota use. The tests below
  // keep the leg's own behavior pinned so the gated path still works.
  //
  // It is also BUFFERED. Nothing renders it: the panel shows the finished
  // result and a hint that a better one may replace it, so streaming its
  // tokens would buy nothing and would put a second live preview on a screen
  // that is already showing a completed run.

  // The shipped default, pinned directly: no flag, no tail. A regression here
  // is not cosmetic — it silently spends the free leg the user's own refine
  // needs, so their next refine gets charged, and it doubles per-IP quota use.
  it("does NOT auto-refine by default: one tailor, one rescore, never refining", async () => {
    let tailorCalls = 0;
    let rescoreCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (url) => {
        const u = String(url);
        if (u.endsWith("/api/analyze"))
          return sse({ analysis: { overall_match_score: 60 }, remaining: 4 });
        if (u.endsWith("/api/tailor")) {
          tailorCalls += 1;
          return sse({
            tailored: { projected_match_score: 70, resume: { summary: `v${tailorCalls}` } },
            remaining: 4,
          });
        }
        rescoreCalls += 1;
        return json({ score: 65 });
      }),
    );

    const { patches, onUpdate } = collect();
    await runTailor(JD, RESUME, onUpdate);

    expect(tailorCalls).toBe(1);
    expect(rescoreCalls).toBe(1);
    // `refining` is published as false by the reading and done patches; what
    // must never happen is a patch turning it ON, which is the panel's cue
    // that a second leg is in flight.
    expect(patches.some((p) => p.refining === true)).toBe(false);
    // The run ends on the measurement, with the first tailor's document.
    expect(patches.at(-1)).toEqual({ rescoredScore: 65 });
    const withTailored = patches.filter((p) => p.tailored);
    expect(withTailored.at(-1)?.tailored).toMatchObject({ resume: { summary: "v1" } });
  });

  it("auto-refines after the first rescore: tailor with analysis, rescore again, adopt when not worse", async () => {
    const tailorBodies: Record<string, unknown>[] = [];
    let tailorCalls = 0;
    let rescoreCalls = 0;
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const u = String(url);
      if (u.endsWith("/api/analyze"))
        return sse({
          analysis: { overall_match_score: 60, requirements_matrix: [] },
          remaining: 4,
        });
      if (u.endsWith("/api/tailor")) {
        tailorCalls += 1;
        tailorBodies.push(JSON.parse(String(init?.body)));
        // The refine leg's read is LOWER than the done patch's: the charge for
        // this run committed after the first two reads answered.
        const body = {
          tailored: { projected_match_score: 70, resume: { summary: `v${tailorCalls}` } },
          remaining: tailorCalls === 1 ? 4 : 3,
        };
        // First leg streams; the refine leg is a plain buffered POST.
        return tailorCalls === 1 ? sse(body) : json(body);
      }
      // /api/rescore: first measurement 65, refined measurement 72
      rescoreCalls += 1;
      return json({ score: rescoreCalls === 1 ? 65 : 72 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { patches, onUpdate } = collect();
    await runTailor(JD, RESUME, onUpdate, { autoRefine: true });

    expect(tailorCalls).toBe(2);
    expect(rescoreCalls).toBe(2);
    // The refine tailor call carries the analysis; the first one does not.
    expect(tailorBodies[0].analysis).toBeUndefined();
    expect(tailorBodies[1].analysis).toEqual({ overall_match_score: 60, requirements_matrix: [] });
    // ...and asks for a buffered response, unlike the first.
    expect(tailorBodies[0].stream).toBe(true);
    expect(tailorBodies[1].stream).toBeUndefined();
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
      if (u.endsWith("/api/analyze"))
        return sse({ analysis: { overall_match_score: 60 }, remaining: 4 });
      if (u.endsWith("/api/tailor")) {
        tailorCalls += 1;
        const body = {
          tailored: { projected_match_score: 70, resume: { summary: `v${tailorCalls}` } },
          remaining: 4,
        };
        return tailorCalls === 1 ? sse(body) : json(body);
      }
      rescoreCalls += 1;
      return json({ score: rescoreCalls === 1 ? 65 : 58 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { patches, onUpdate } = collect();
    await runTailor(JD, RESUME, onUpdate, { autoRefine: true });

    // Worse measurement: keep v1 and 65 on screen; only `refining:false` published after.
    const withTailored = patches.filter((p) => p.tailored);
    expect(withTailored[withTailored.length - 1].tailored).toMatchObject({ resume: { summary: "v1" } });
    expect(patches.filter((p) => typeof p.rescoredScore === "number").pop()?.rescoredScore).toBe(65);
  });

  // Both skip tests turn the flag ON deliberately: the point is that the
  // `priorAnalysis || isRefinement` guard is independent of it, and still
  // refuses the tail on a run that IS itself the second free leg.
  it("skips the auto-refine on a run that carries priorAnalysis, and sends it to tailor", async () => {
    const tailorBodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const u = String(url);
      if (u.endsWith("/api/analyze"))
        return sse({ analysis: { overall_match_score: 60 }, remaining: 4 });
      if (u.endsWith("/api/tailor")) {
        tailorBodies.push(JSON.parse(String(init?.body)));
        return sse({ tailored: { projected_match_score: 70 }, remaining: 4 });
      }
      return json({ score: 66 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const prior = { overall_match_score: 55, requirements_matrix: [] } as unknown as GapAnalysis;
    await runTailor(JD, RESUME, () => {}, { runId: "reused-id", priorAnalysis: prior, autoRefine: true });

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
      if (u.endsWith("/api/analyze"))
        return sse({ analysis: { overall_match_score: 60 }, remaining: 4 });
      if (u.endsWith("/api/tailor")) {
        tailorBodies.push(JSON.parse(String(init?.body)));
        return sse({ tailored: { projected_match_score: 70 }, remaining: 4 });
      }
      return json({ score: 66 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await runTailor(JD, RESUME, () => {}, { runId: "reused-id", isRefinement: true, autoRefine: true });

    expect(tailorBodies).toHaveLength(1);
    // Nothing to aim at, so nothing is sent — but the tail is still skipped.
    expect(tailorBodies[0].analysis).toBeUndefined();
    const rescoreHits = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/api/rescore"));
    expect(rescoreHits).toHaveLength(1);
  });

  // ------------------------------------------------------- the score floor
  //
  // The rescore now answers with the matrix it always computed, so a dipped
  // number can be read against WHY it dipped. Three displays come out of that,
  // and one repair leg sits between them:
  //
  //   measured >= left            -> the measurement, bare (today's behaviour)
  //   dip, nothing got worse      -> the LEFT score, note "maintained"
  //   dip, something got worse    -> one free matrix-aimed rewrite, re-measure,
  //                                  then re-branch on whichever measurement
  //                                  stands. Residuals: nice-to-have only keeps
  //                                  the LEFT score with note "nice_dip"; a
  //                                  must-have that survived the repair is the
  //                                  ONE display allowed to show a lower number
  //                                  (note "downgraded").
  //
  // The old-server guard is what makes the deploy order safe: a rescore body
  // with no rows is never compared and never repaired.

  const LEFT_ANALYSIS = {
    overall_match_score: 70,
    requirements_matrix: [
      {
        requirement: "Go microservices at scale",
        kind: "must_have",
        status: "met",
        evidence: "",
        suggestion: "",
      },
      {
        requirement: "Kubernetes cluster operations",
        kind: "nice_to_have",
        status: "met",
        evidence: "",
        suggestion: "",
      },
    ],
  };

  /** The two rows above as /api/rescore returns them, at the statuses given. */
  const rescoreRows = (must: string, nice: string) => [
    { requirement: "Go microservices at scale", kind: "must_have", status: must },
    { requirement: "Kubernetes cluster operations", kind: "nice_to_have", status: nice },
  ];

  /**
   * The URL-dispatch mock again, with the rescore leg answering from a queue.
   *
   * Each entry is one whole /api/rescore body — `rows` omitted means an old
   * server — and the last entry repeats, so a test that expects one
   * measurement fails loudly on call counts rather than on a missing body.
   * The tailor leg streams its first call and buffers every one after it,
   * which is the shape both free legs (auto-refine and repair) use.
   */
  function runWith(
    measurements: { score: unknown; rows?: unknown[] }[],
    analysis: unknown = LEFT_ANALYSIS,
  ) {
    const tailorBodies: Record<string, unknown>[] = [];
    let tailorCalls = 0;
    let rescoreCalls = 0;
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const u = String(url);
      if (u.endsWith("/api/analyze")) return sse({ analysis, remaining: 4 });
      if (u.endsWith("/api/tailor")) {
        tailorCalls += 1;
        tailorBodies.push(JSON.parse(String(init?.body)));
        const body = {
          tailored: { projected_match_score: 75, resume: { summary: `v${tailorCalls}` } },
          remaining: 4,
        };
        return tailorCalls === 1 ? sse(body) : json(body);
      }
      const measurement = measurements[Math.min(rescoreCalls, measurements.length - 1)];
      rescoreCalls += 1;
      return json(measurement);
    });
    vi.stubGlobal("fetch", fetchMock);
    return {
      fetchMock,
      tailorBodies,
      counts: () => ({ tailor: tailorCalls, rescore: rescoreCalls }),
    };
  }

  // (a)
  it("publishes the measurement as-is when it did not fall below the analysis score", async () => {
    const run = runWith([{ score: 74, rows: rescoreRows("met", "met") }]);
    const { patches, onUpdate } = collect();
    await runTailor(JD, RESUME, onUpdate);

    // The default budget, unchanged: nothing above the floor costs a leg.
    expect(run.counts()).toEqual({ tailor: 1, rescore: 1 });
    expect(patches.at(-1)).toEqual({
      rescoredScore: 74,
      scoreNote: null,
      downgradedRequirements: [],
    });
    expect(patches.some((p) => p.refining === true)).toBe(false);
  });

  // (b) — the noise case, and the reason the repair is gated on the MATRIX
  // rather than on the number. The instrument is a model: it answers a few
  // points apart on two readings of the same document. A dip with nothing
  // behind it is not worth a second tailor.
  it("holds the left score when the number dips but no requirement got worse", async () => {
    const run = runWith([{ score: 66, rows: rescoreRows("met", "met") }]);
    const { patches, onUpdate } = collect();
    await runTailor(JD, RESUME, onUpdate);

    expect(run.counts()).toEqual({ tailor: 1, rescore: 1 });
    expect(patches.at(-1)).toEqual({
      rescoredScore: 70,
      scoreNote: "maintained",
      downgradedRequirements: [],
    });
    // No repair: zero downgrades is noise, and a second tailor would spend the
    // free leg the user's own refine needs to find nothing.
    expect(patches.some((p) => p.refining === true)).toBe(false);
  });

  // (c) + the recovery half of (d)
  it("repairs a dip that lost a requirement: a second tailor WITH the analysis, then a second rescore", async () => {
    const run = runWith([
      { score: 66, rows: rescoreRows("met", "partially_met") },
      { score: 71, rows: rescoreRows("met", "met") },
    ]);
    const { patches, onUpdate } = collect();
    await runTailor(JD, RESUME, onUpdate);

    // The repair budget: exactly the shape the gated auto-refine leg has.
    expect(run.counts()).toEqual({ tailor: 2, rescore: 2 });
    // The repair rewrite aims at the matrix, is buffered (nothing renders it),
    // and rides the SAME runId — it is a free leg, not a second charge.
    expect(run.tailorBodies[0].analysis).toBeUndefined();
    expect(run.tailorBodies[1].analysis).toEqual(LEFT_ANALYSIS);
    expect(run.tailorBodies[1].stream).toBeUndefined();
    expect(run.tailorBodies[1].runId).toBe(run.tailorBodies[0].runId);

    // The repaired rewrite measures back above the left score, so it is
    // adopted and displayed bare — the dip never happened as far as the panel
    // is concerned.
    expect(patches.at(-1)).toMatchObject({
      rescoredScore: 71,
      scoreNote: null,
      downgradedRequirements: [],
      tailored: { resume: { summary: "v2" } },
      refining: false,
    });
  });

  // (d)
  it("shows maintained after a repair that fixed the rows but not the number", async () => {
    const run = runWith([
      { score: 66, rows: rescoreRows("met", "partially_met") },
      { score: 68, rows: rescoreRows("met", "met") },
    ]);
    const { patches, onUpdate } = collect();
    await runTailor(JD, RESUME, onUpdate);

    expect(run.counts()).toEqual({ tailor: 2, rescore: 2 });
    expect(patches.at(-1)).toMatchObject({
      // Zero residual downgrades, so the dip is noise again: the left number.
      rescoredScore: 70,
      scoreNote: "maintained",
      downgradedRequirements: [],
      tailored: { resume: { summary: "v2" } },
      refining: false,
    });
  });

  // (e)
  it("keeps the left number and names the row when only a nice-to-have survives the repair", async () => {
    const run = runWith([
      { score: 66, rows: rescoreRows("met", "missing") },
      { score: 67, rows: rescoreRows("met", "partially_met") },
    ]);
    const { patches, onUpdate } = collect();
    await runTailor(JD, RESUME, onUpdate);

    expect(run.counts()).toEqual({ tailor: 2, rescore: 2 });
    // Not worse than the first measurement and no must-have lost, so the
    // repaired document is adopted — and the number STILL does not drop. The
    // note and the named row are what keep that honest.
    expect(patches.at(-1)).toMatchObject({
      rescoredScore: 70,
      scoreNote: "nice_dip",
      downgradedRequirements: ["Kubernetes cluster operations"],
      tailored: { resume: { summary: "v2" } },
      refining: false,
    });
  });

  // (f) — the only display whose number is allowed to be lower than the left
  // score, and (with the adoption gate above it) the one expected never to
  // appear in production.
  it("shows the measured number, the note and the row when a must-have survives the repair", async () => {
    const run = runWith([
      { score: 60, rows: rescoreRows("missing", "met") },
      { score: 62, rows: rescoreRows("missing", "met") },
    ]);
    const { patches, onUpdate } = collect();
    await runTailor(JD, RESUME, onUpdate);

    // The repair ran ONCE. A must-have residual is not a reason to try again:
    // there is no third free leg, and a loop here would spend the user's own
    // refine allowance on a rewrite it cannot adopt either.
    expect(run.counts()).toEqual({ tailor: 2, rescore: 2 });
    const final = patches.at(-1)!;
    expect(final).toMatchObject({
      rescoredScore: 60,
      scoreNote: "downgraded",
      downgradedRequirements: ["Go microservices at scale"],
      refining: false,
    });
    // The repaired rewrite still loses the must-have, so it is NOT adopted:
    // the document on screen stays the one the user already has.
    expect(final.tailored).toBeUndefined();
    expect(patches.filter((p) => p.tailored).at(-1)?.tailored).toMatchObject({
      resume: { summary: "v1" },
    });
  });

  // (g) — THE deploy-order guard. An extension that ships before the widened
  // rescore response (or one talking to a stale deployment) gets a bare score,
  // and a bare score is displayed exactly as it is today. Comparing against an
  // absent matrix would read every met requirement as vanished and turn every
  // run into a "downgraded" display.
  it("behaves exactly as before when the rescore body carries no rows", async () => {
    const run = runWith([{ score: 60 }]);
    const { patches, onUpdate } = collect();
    await runTailor(JD, RESUME, onUpdate);

    expect(run.counts()).toEqual({ tailor: 1, rescore: 1 });
    // Below the left score, and shown anyway: with no rows there is nothing to
    // compare, so there is no honest reason to hold the number up.
    expect(patches.at(-1)).toEqual({ rescoredScore: 60 });
    expect(patches.some((p) => p.refining === true)).toBe(false);
  });

  // (h) — the panel puts the score slot on a placeholder while `refining` is
  // true and no note has been decided. If a rescoredScore were published
  // before that flag, the user would watch the number drop to the dipped
  // measurement and then jump back up, which is the exact flicker the whole
  // hold-the-number design exists to avoid.
  it("turns refining on before it publishes any score during a repair", async () => {
    runWith([
      { score: 66, rows: rescoreRows("met", "missing") },
      { score: 67, rows: rescoreRows("met", "met") },
    ]);
    const { patches, onUpdate } = collect();
    await runTailor(JD, RESUME, onUpdate);

    const refiningAt = patches.findIndex((p) => p.refining === true);
    const scored = patches.filter((p) => p.rescoredScore != null);
    expect(refiningAt).toBeGreaterThanOrEqual(0);
    expect(patches.findIndex((p) => p.rescoredScore != null)).toBeGreaterThan(refiningAt);
    // Exactly one number is ever published, and it is the decided one. The
    // intermediate 66 never reaches the panel.
    expect(scored).toHaveLength(1);
    expect(scored[0].rescoredScore).toBe(70);
  });

  // (i) — the same completeness rule the streaming fields have: a terminal
  // patch describes terminal state completely, because App.tsx resets state on
  // a JD URL change and a patch that omitted these would leave the previous
  // run's note beside this run's number.
  it("clears the note and the named rows in every terminal patch", async () => {
    runWith([{ score: 66, rows: rescoreRows("met", "missing") }]);
    const { patches, onUpdate } = collect();
    await runTailor(JD, RESUME, onUpdate);

    expect(patches[0]).toMatchObject({
      phase: "reading",
      scoreNote: null,
      downgradedRequirements: [],
    });
    expect(patches.find((p) => p.phase === "done")).toMatchObject({
      scoreNote: null,
      downgradedRequirements: [],
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ error: "You've used all your free runs." }, 402)),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const failed = collect();
    await runTailor(JD, RESUME, failed.onUpdate);
    expect(failed.patches.at(-1)).toMatchObject({
      phase: "error",
      scoreNote: null,
      downgradedRequirements: [],
    });
  });

  // A refine run IS the second free leg. Repairing it would send the runId's
  // third tailor and third rescore — refused by the server, and it would burn
  // the allowance the user's NEXT refine needs. The display still tells the
  // truth; only the repair is skipped.
  it("never repairs a refinement run, and still decides the display", async () => {
    const run = runWith([{ score: 66, rows: rescoreRows("met", "missing") }]);
    const { patches, onUpdate } = collect();
    await runTailor(JD, RESUME, onUpdate, { runId: "reused-id", isRefinement: true });

    expect(run.counts()).toEqual({ tailor: 1, rescore: 1 });
    expect(patches.some((p) => p.refining === true)).toBe(false);
    expect(patches.at(-1)).toEqual({
      rescoredScore: 70,
      scoreNote: "nice_dip",
      downgradedRequirements: ["Kubernetes cluster operations"],
    });
  });

  // Both legs are the SAME free leg. Running them back to back would send the
  // runId a third tailor and a third rescore for a rewrite the repair already
  // produced and measured.
  it("does not also run the gated auto-refine tail after a repair", async () => {
    const run = runWith([
      { score: 66, rows: rescoreRows("met", "missing") },
      { score: 67, rows: rescoreRows("met", "met") },
    ]);
    await runTailor(JD, RESUME, () => {}, { autoRefine: true });

    expect(run.counts()).toEqual({ tailor: 2, rescore: 2 });
  });
});
