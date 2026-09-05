import { describe, it, expect, beforeEach, vi } from "vitest";

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
      await analyze(post("https://x/api/analyze", inputs({ stream: true, runId: `f${i}` })));
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
      await tailor(post("https://x/api/tailor", inputs({ stream: true, runId: `t${i}` })));
    }
    vi.mocked(streamLLM).mockClear();

    const res = await tailor(post("https://x/api/tailor", inputs({ stream: true })));

    expect(res.status).toBe(402);
    expect(vi.mocked(streamLLM)).not.toHaveBeenCalled();
  });
});
