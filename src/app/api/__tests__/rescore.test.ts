import { describe, it, expect, beforeEach, vi } from "vitest";

// Must be hoisted above the route imports.
vi.mock("@/lib/llm", () => ({ callLLM: vi.fn() }));
vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(async () => ({ userId: null })),
}));

import { callLLM } from "@/lib/llm";
import { getKV, resetKV } from "@/lib/kv";
import { getQuota } from "@/lib/quota";
import type { Caller } from "@/lib/auth";
import { POST as analyze } from "@/app/api/analyze/route";
import { POST as tailor } from "@/app/api/tailor/route";
import { POST as rescore } from "@/app/api/rescore/route";

const IP = "6.6.6.6";
const ANON = "rescore-test-anon";
const caller: Caller = { kind: "anon", anonId: ANON };

const used = async () => (await getQuota(caller, IP)).used;
const marker = (runId: string) => `run:anon:${ANON}:${runId}`;

function post(
  url: string,
  payload: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-anon-id": ANON,
      "x-forwarded-for": IP,
      ...headers,
    },
    body: JSON.stringify(payload),
  });
}

const inputs = (runId?: string) => ({
  structuredResume: { contact: { name: "A" } },
  structuredJD: { company: "B" },
  ...(runId ? { runId } : {}),
});

/** Runs a real charged generate so the run marker exists, as it would live. */
async function generate(runId: string) {
  await analyze(post("https://x/api/analyze", inputs(runId)));
  await tailor(post("https://x/api/tailor", inputs(runId)));
}

describe("POST /api/rescore", () => {
  beforeEach(() => {
    resetKV();
    vi.mocked(callLLM).mockReset();
    vi.mocked(callLLM).mockResolvedValue({ overall_match_score: 81 } as never);
    delete process.env.BETA_ACCESS_CODES;
  });

  it("returns the analyze score of the resume it was handed", async () => {
    await generate("r1");
    const res = await rescore(post("https://x/api/rescore", inputs("r1")));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ score: 81 });
  });

  // "Same instrument" is the entire premise. A cheaper bespoke prompt would
  // save tokens and silently destroy the calibration the delta depends on, so
  // pin the call shape: the analyze task (which routes the model), JSON mode,
  // and no temperature override (analyze's default is 0).
  it("calls the LLM through the analyze task with no temperature override", async () => {
    await generate("r-instrument");
    await rescore(post("https://x/api/rescore", inputs("r-instrument")));

    // Three calls: analyze, tailor, rescore. The last is ours.
    const args = vi.mocked(callLLM).mock.calls.at(-1)?.[0];
    expect(args?.task).toBe("analyze");
    expect(args?.json).toBe(true);
    expect(args?.temperature).toBeUndefined();

    // The prompt itself must be analyze's, byte for byte — compare against
    // what the analyze route sent for the same inputs.
    expect(args?.messages).toEqual(vi.mocked(callLLM).mock.calls[0][0].messages);
  });

  // ------------------------------------------------------------- the gates

  // THE load-bearing invariant. quota.ts pairs analyze/tailor legs off the run
  // marker's PARITY, so a single extra incr from this route shifts every later
  // leg by one and starts charging refinements that are meant to be free. This
  // route may only READ that key.
  it("does not touch the run marker", async () => {
    await generate("r-marker");
    const before = await getKV().getCount(marker("r-marker"));
    expect(before).toBe(2); // analyze + tailor

    await rescore(post("https://x/api/rescore", inputs("r-marker")));
    await rescore(post("https://x/api/rescore", inputs("r-marker")));

    expect(await getKV().getCount(marker("r-marker"))).toBe(2);
  });

  it("charges no quota", async () => {
    await generate("r-free");
    expect(await used()).toBe(1);

    await rescore(post("https://x/api/rescore", inputs("r-free")));

    expect(await used()).toBe(1);
  });

  // The abuse surface this route would otherwise open: extension code is
  // public, so an unauthenticated free analyze-grade endpoint is a gift. Only
  // a runId that was actually charged gets served.
  it("403s a runId that was never charged, before any LLM call", async () => {
    const res = await rescore(post("https://x/api/rescore", inputs("never-happened")));
    expect(res.status).toBe(403);
    expect(vi.mocked(callLLM)).not.toHaveBeenCalled();
  });

  // A missing id cannot be waved through with a minted one the way analyze
  // does: the marker gate is the only thing standing here.
  it("400s when no runId is supplied", async () => {
    const res = await rescore(post("https://x/api/rescore", inputs()));
    expect(res.status).toBe(400);
    expect(vi.mocked(callLLM)).not.toHaveBeenCalled();
  });

  // The marker is keyed on the CALLER as well as the run, so another
  // identity's runId buys nothing.
  it("403s a runId charged to a different caller", async () => {
    await generate("r-mine");
    const res = await rescore(
      post("https://x/api/rescore", inputs("r-mine"), { "x-anon-id": "someone-else" }),
    );
    expect(res.status).toBe(403);
  });

  it("400s a malformed body without consulting the store", async () => {
    const res = await rescore(post("https://x/api/rescore", { runId: "r1" }));
    expect(res.status).toBe(400);
    expect(vi.mocked(callLLM)).not.toHaveBeenCalled();
  });

  // One generate plus FREE_REFINES refinements is three rescores. The fourth
  // is a client that re-scored more times than it could have generated.
  it("caps a single run at three rescores", async () => {
    await generate("r-cap");
    for (let i = 0; i < 3; i++) {
      expect((await rescore(post("https://x/api/rescore", inputs("r-cap")))).status).toBe(200);
    }
    const res = await rescore(post("https://x/api/rescore", inputs("r-cap")));
    expect(res.status).toBe(429);
    expect(vi.mocked(callLLM)).toHaveBeenCalledTimes(2 + 3); // generate + 3 rescores
  });

  // Verified against analyze/tailor rather than assumed: both `return` before
  // consumeRun when hasBetaAccess is true, so a beta generate writes NO run
  // marker. Without this bypass every beta tester would 403 on every run.
  it("skips the marker gate for a beta caller", async () => {
    process.env.BETA_ACCESS_CODES = "letmein";
    const beta = { "x-access-code": "letmein" };
    await analyze(post("https://x/api/analyze", inputs("r-beta"), beta));
    await tailor(post("https://x/api/tailor", inputs("r-beta"), beta));
    // The premise of the bypass, asserted rather than trusted.
    expect(await getKV().getCount(marker("r-beta"))).toBe(0);

    const res = await rescore(post("https://x/api/rescore", inputs("r-beta"), beta));
    expect(res.status).toBe(200);
  });

  // The bypass is for the MARKER only. The per-run ceiling still bounds what a
  // leaked beta code can spend.
  it("still caps a beta caller's rescores", async () => {
    process.env.BETA_ACCESS_CODES = "letmein";
    const beta = { "x-access-code": "letmein" };
    for (let i = 0; i < 3; i++) {
      expect(
        (await rescore(post("https://x/api/rescore", inputs("r-beta-cap"), beta))).status,
      ).toBe(200);
    }
    expect(
      (await rescore(post("https://x/api/rescore", inputs("r-beta-cap"), beta))).status,
    ).toBe(429);
  });

  // Same rule as every other route: a present-but-invalid bearer is an
  // extension whose token expired and must be told so, never silently
  // downgraded to the anonymous bucket.
  it("401s on a present-but-invalid bearer token, before any LLM call", async () => {
    const res = await rescore(
      post("https://x/api/rescore", inputs("r1"), { authorization: "Bearer nope" }),
    );
    expect(res.status).toBe(401);
    expect(vi.mocked(callLLM)).not.toHaveBeenCalled();
  });

  it("502s when the model call fails, leaving quota untouched", async () => {
    await generate("r-boom");
    vi.mocked(callLLM).mockRejectedValue(new Error("upstream down"));

    const res = await rescore(post("https://x/api/rescore", inputs("r-boom")));

    expect(res.status).toBe(502);
    expect(await used()).toBe(1);
  });
});
