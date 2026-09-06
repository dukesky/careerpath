import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * The opt-in `stream: true` branch of /api/analyze and /api/tailor.
 *
 * The frame contract asserted here is consumed verbatim by the extension, so
 * these tests are the contract: `{"d":…}` deltas, one `{"final":…}` frame with
 * the same shape the buffered response returns, then `[DONE]`.
 */

// Must be hoisted above the route imports. `stripCodeFences` stays real — it is
// the routes' own parsing step, not a collaborator worth faking.
vi.mock("@/lib/llm", async () => {
  const actual = await vi.importActual<typeof import("@/lib/llm")>("@/lib/llm");
  return {
    callLLM: vi.fn(),
    streamLLM: vi.fn(),
    stripCodeFences: actual.stripCodeFences,
  };
});
vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(async () => ({ userId: null })),
}));

import { callLLM, streamLLM } from "@/lib/llm";
import { resetKV } from "@/lib/kv";
import { getQuota } from "@/lib/quota";
import type { Caller } from "@/lib/auth";
import { POST as analyze } from "@/app/api/analyze/route";
import { POST as tailor } from "@/app/api/tailor/route";
import { sseResponse, drainDeltas } from "@/lib/sse";

const IP = "8.8.8.8";
const ANON = "streaming-test-anon";
const caller: Caller = { kind: "anon", anonId: ANON };

const used = async () => (await getQuota(caller, IP)).used;

function post(url: string, payload: Record<string, unknown>) {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-anon-id": ANON,
      "x-forwarded-for": IP,
    },
    body: JSON.stringify(payload),
  });
}

const inputs = (extra: Record<string, unknown> = {}) => ({
  structuredResume: { contact: { name: "A" } },
  structuredJD: { company: "B" },
  ...extra,
});

/** Makes streamLLM yield `deltas` and return their concatenation as full text. */
function yields(...deltas: string[]) {
  vi.mocked(streamLLM).mockImplementation((() =>
    (async function* () {
      for (const d of deltas) yield d;
      return deltas.join("");
    })()) as unknown as typeof streamLLM);
}

/** The payload of each `data: …` frame, in order. */
async function frames(res: Response): Promise<string[]> {
  const text = await new Response(res.body).text();
  return text
    .split("\n\n")
    .filter((f) => f !== "")
    .map((f) => {
      expect(f.startsWith("data: ")).toBe(true);
      return f.slice("data: ".length);
    });
}

const ANALYZE_JSON = '{"overall_match_score":73,"rationale":"close"}';
const TAILOR_JSON =
  '{"resume":{"contact":{"name":"A"}},"projected_match_score":88}';

beforeEach(() => {
  resetKV();
  vi.mocked(callLLM).mockReset();
  vi.mocked(callLLM).mockResolvedValue({} as never);
  vi.mocked(streamLLM).mockReset();
  delete process.env.BETA_ACCESS_CODES;
});

describe("POST /api/analyze with stream: true", () => {
  it("streams deltas, then one final frame, then [DONE]", async () => {
    yields('{"overall_match', '_score":73,', '"rationale":"close"}');

    const res = await analyze(post("https://x/api/analyze", inputs({ stream: true })));

    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-store");

    const got = await frames(res);
    expect(got.slice(0, 3)).toEqual([
      '{"d":"{\\"overall_match"}',
      '{"d":"_score\\":73,"}',
      '{"d":"\\"rationale\\":\\"close\\"}"}',
    ]);
    expect(got.at(-1)).toBe("[DONE]");

    const final = JSON.parse(got.at(-2)!) as {
      final: { analysis: { overall_match_score: number }; remaining: number | null };
    };
    expect(final.final.analysis.overall_match_score).toBe(73);
  });

  // consumeRun runs once, after the parse, so the final frame carries the same
  // `remaining` the buffered response would have.
  it("charges exactly one run and reports the remainder in the final frame", async () => {
    yields(ANALYZE_JSON);

    const res = await analyze(
      post("https://x/api/analyze", inputs({ stream: true, runId: "s1" })),
    );
    const got = await frames(res);

    expect(await used()).toBe(1);
    expect(JSON.parse(got.at(-2)!).final.remaining).toBe(4);
  });

  // The stream's own text was garbage; the buffered path (which owns its single
  // retry) supplies the result and the client never sees the difference.
  it("falls back to one buffered callLLM when the streamed text will not parse", async () => {
    yields("Sorry, I cannot help with that.");
    vi.mocked(callLLM).mockResolvedValue({ overall_match_score: 61 } as never);

    const res = await analyze(post("https://x/api/analyze", inputs({ stream: true })));
    const got = await frames(res);

    expect(vi.mocked(callLLM)).toHaveBeenCalledTimes(1);
    expect(JSON.parse(got.at(-2)!).final.analysis.overall_match_score).toBe(61);
    expect(got.at(-1)).toBe("[DONE]");
  });

  it("sends an error frame and no [DONE] when the model call fails", async () => {
    vi.mocked(streamLLM).mockImplementation((() =>
      (async function* (): AsyncGenerator<string, string> {
        throw new Error("upstream down");
      })()) as unknown as typeof streamLLM);

    const res = await analyze(post("https://x/api/analyze", inputs({ stream: true })));
    const got = await frames(res);

    expect(got).toEqual(['{"error":"upstream down"}']);
    expect(await used()).toBe(0);
  });

  // Every gate stays in front of the stream: a refused request must still be a
  // plain JSON error the client can read, not an SSE body.
  it("returns the buffered 402 JSON without opening a stream once exhausted", async () => {
    yields(ANALYZE_JSON);
    for (let i = 0; i < 5; i++) {
      // Read each body to completion: the charge happens in the last frame, so
      // an unread stream would leave the quota state up to scheduling luck.
      await frames(
        await analyze(post("https://x/api/analyze", inputs({ stream: true, runId: `f${i}` }))),
      );
    }
    vi.mocked(streamLLM).mockClear();

    const res = await analyze(
      post("https://x/api/analyze", inputs({ stream: true, runId: "over" })),
    );

    expect(res.status).toBe(402);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "You've used all your free runs.", remaining: 0 });
    expect(vi.mocked(streamLLM)).not.toHaveBeenCalled();
  });

  it("rejects a malformed body before opening a stream", async () => {
    yields(ANALYZE_JSON);

    const res = await analyze(post("https://x/api/analyze", { stream: true }));

    expect(res.status).toBe(400);
    expect(vi.mocked(streamLLM)).not.toHaveBeenCalled();
  });

  // Without `stream: true` nothing changes — the existing suites are the real
  // guard, this just pins that the streaming client is never engaged.
  it("stays on the buffered path when stream is absent", async () => {
    const res = await analyze(post("https://x/api/analyze", inputs()));

    expect(res.headers.get("content-type")).toContain("application/json");
    expect(vi.mocked(streamLLM)).not.toHaveBeenCalled();
    expect(vi.mocked(callLLM)).toHaveBeenCalledTimes(1);
  });

  it("reports remaining: null for a beta caller without charging", async () => {
    process.env.BETA_ACCESS_CODES = "letmein";
    yields(ANALYZE_JSON);

    const res = await analyze(
      new Request("https://x/api/analyze", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-anon-id": ANON,
          "x-forwarded-for": IP,
          "x-access-code": "letmein",
        },
        body: JSON.stringify(inputs({ stream: true, runId: "beta" })),
      }),
    );
    const got = await frames(res);

    expect(JSON.parse(got.at(-2)!).final.remaining).toBeNull();
    expect(await used()).toBe(0);
  });

  it("streams the same prompt the buffered path would have sent", async () => {
    yields(ANALYZE_JSON);

    await analyze(post("https://x/api/analyze", inputs({ stream: true })));
    await analyze(post("https://x/api/analyze", inputs()));

    const streamed = vi.mocked(streamLLM).mock.calls[0][0];
    const buffered = vi.mocked(callLLM).mock.calls[0][0];
    expect(streamed.messages).toEqual(buffered.messages);
    expect(streamed.task).toBe("analyze");
    expect(streamed.maxTokens).toBe(buffered.maxTokens);
  });
});

describe("POST /api/tailor with stream: true", () => {
  it("streams deltas, then a final frame keyed `tailored`, then [DONE]", async () => {
    yields("{", '"resume":{"contact":{"name":"A"}},', '"projected_match_score":88}');

    const res = await tailor(post("https://x/api/tailor", inputs({ stream: true })));

    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-store");

    const got = await frames(res);
    expect(got.slice(0, 3).map((f) => JSON.parse(f).d)).toEqual([
      "{",
      '"resume":{"contact":{"name":"A"}},',
      '"projected_match_score":88}',
    ]);
    expect(got.at(-1)).toBe("[DONE]");

    const final = JSON.parse(got.at(-2)!) as {
      final: { tailored: { projected_match_score: number }; remaining: number | null };
    };
    expect(final.final.tailored.projected_match_score).toBe(88);
    expect(final.final.remaining).toBe(4);
  });

  it("falls back to one buffered callLLM when the streamed text will not parse", async () => {
    yields("not json at all");
    vi.mocked(callLLM).mockResolvedValue({
      resume: { contact: { name: "A" } },
      projected_match_score: 55,
    } as never);

    const res = await tailor(post("https://x/api/tailor", inputs({ stream: true })));
    const got = await frames(res);

    expect(vi.mocked(callLLM)).toHaveBeenCalledTimes(1);
    expect(JSON.parse(got.at(-2)!).final.tailored.projected_match_score).toBe(55);
  });

  // The optional `analysis` input is part of tailor's prompt; the streaming
  // branch must not quietly drop it.
  it("streams the same prompt the buffered path would have sent, analysis included", async () => {
    yields(TAILOR_JSON);
    const withAnalysis = inputs({ analysis: { overall_match_score: 40 } });

    await tailor(post("https://x/api/tailor", { ...withAnalysis, stream: true }));
    await tailor(post("https://x/api/tailor", withAnalysis));

    const streamed = vi.mocked(streamLLM).mock.calls[0][0];
    const buffered = vi.mocked(callLLM).mock.calls[0][0];
    expect(streamed.messages).toEqual(buffered.messages);
    expect(streamed.task).toBe("tailor");
    expect(streamed.maxTokens).toBe(buffered.maxTokens);
  });

  it("returns the buffered 402 JSON without opening a stream once exhausted", async () => {
    yields(TAILOR_JSON);
    for (let i = 0; i < 5; i++) {
      // Read each body to completion: the charge happens in the last frame, so
      // an unread stream would leave the quota state up to scheduling luck.
      await frames(
        await tailor(post("https://x/api/tailor", inputs({ stream: true, runId: `t${i}` }))),
      );
    }
    vi.mocked(streamLLM).mockClear();

    const res = await tailor(post("https://x/api/tailor", inputs({ stream: true })));

    expect(res.status).toBe(402);
    expect(vi.mocked(streamLLM)).not.toHaveBeenCalled();
  });
});

/**
 * A cancelled stream swallows whatever the producer does next — the rejection
 * of an already-closed stream's `start` goes nowhere — so what the helper does
 * to its controller after a disconnect is invisible from the Response. These
 * tests watch the controller itself.
 */
function recordController(opts: { failEnqueueAfter?: number } = {}) {
  const rec = { enqueues: 0, closes: 0, throws: [] as unknown[] };
  const Real = globalThis.ReadableStream;

  const spy = <R,>(c: ReadableStreamDefaultController<R>) => ({
    get desiredSize() {
      return c.desiredSize;
    },
    enqueue(chunk: R) {
      rec.enqueues++;
      // The other way a client goes away: the socket faults under us and the
      // stream's own cancel() never runs, so `cancelled` stays false while
      // every enqueue from here on throws.
      if (opts.failEnqueueAfter !== undefined && rec.enqueues > opts.failEnqueueAfter) {
        throw new TypeError("Invalid state: Controller is already closed");
      }
      try {
        c.enqueue(chunk);
      } catch (err) {
        rec.throws.push(err);
        throw err;
      }
    },
    close() {
      rec.closes++;
      try {
        c.close();
      } catch (err) {
        rec.throws.push(err);
        throw err;
      }
    },
    error(err?: unknown) {
      c.error(err);
    },
  });

  class Recording<R> extends Real<R> {
    constructor(source?: UnderlyingSource<R>, strategy?: QueuingStrategy<R>) {
      const start = source?.start;
      super(
        source &&
          ({
            ...source,
            start:
              start &&
              ((c: ReadableStreamDefaultController<R>) =>
                start.call(
                  source,
                  spy(c) as unknown as ReadableStreamDefaultController<R>,
                )),
          } as unknown as UnderlyingSource<R>),
        strategy,
      );
    }
  }

  vi.stubGlobal("ReadableStream", Recording);
  return rec;
}

describe("sseResponse when the client disconnects", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Lets every pending microtask chain settle. */
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("closes the delta generator and stops writing once cancelled", async () => {
    const rec = recordController();

    let released!: () => void;
    const gate = new Promise<void>((r) => (released = r));
    let finalized = false;

    // The finalizer is the whole point: it is what aborts the upstream fetch
    // inside streamLLM's own `for await`, so billing stops with the client.
    const gen = (async function* (): AsyncGenerator<string, string> {
      try {
        yield "first";
        await gate;
        yield "second";
        return "firstsecond";
      } finally {
        finalized = true;
      }
    })();

    const seen: string[] = [];
    const res = sseResponse(async (send) => {
      const full = await drainDeltas(gen, (delta) => {
        send({ d: delta });
        seen.push(delta);
      });
      send({ final: full });
    });

    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe('data: {"d":"first"}\n\n');

    await reader.cancel();
    released();
    await flush();

    expect(finalized).toBe(true);
    expect(seen).toEqual(["first"]);
    expect(rec.enqueues).toBe(1);
    expect(rec.closes).toBe(0);
    expect(rec.throws).toEqual([]);
  });

  it("does not fault a second time when the producer fails after cancellation", async () => {
    const rec = recordController();

    let released!: () => void;
    const gate = new Promise<void>((r) => (released = r));

    const res = sseResponse(async (send) => {
      send({ d: "first" });
      await gate;
      throw new Error("upstream down");
    });

    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    released();
    await flush();

    // The error frame has nowhere to go, and closing a cancelled controller is
    // the second TypeError; neither may be attempted.
    expect(rec.enqueues).toBe(1);
    expect(rec.closes).toBe(0);
    expect(rec.throws).toEqual([]);
  });

  // The dead-socket case cancel() does NOT cover. `closed` is what a faulted
  // enqueue sets, and until `send` honoured it the producer kept drawing the
  // whole generation out of the model — billed in full — for a reader that
  // had already gone.
  it("stops the producer once a faulted enqueue has marked the stream closed", async () => {
    const rec = recordController({ failEnqueueAfter: 1 });

    let finalized = false;
    let completed = false;

    const gen = (async function* (): AsyncGenerator<string, string> {
      try {
        yield "first";
        yield "second";
        yield "third";
        yield "fourth";
        completed = true;
        return "firstsecondthirdfourth";
      } finally {
        finalized = true;
      }
    })();

    const seen: string[] = [];
    sseResponse(async (send) => {
      const full = await drainDeltas(gen, (delta) => {
        send({ d: delta });
        seen.push(delta);
      });
      send({ final: full });
    });

    await flush();

    // "first" landed; "second" is the enqueue that faults (write swallows it
    // and sets `closed`); by "third" the guard throws ClientGone and the
    // generator is closed by its finalizer rather than by running out.
    expect(seen).toEqual(["first", "second"]);
    expect(rec.enqueues).toBe(2);
    expect(finalized).toBe(true);
    expect(completed).toBe(false);
    expect(rec.closes).toBe(0);
  });
});
