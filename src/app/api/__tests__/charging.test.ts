import { describe, it, expect, beforeEach, vi } from "vitest";

// Must be hoisted above the route imports.
vi.mock("@/lib/llm", () => ({ callLLM: vi.fn() }));
vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(async () => ({ userId: null })),
}));

import { callLLM } from "@/lib/llm";
import { resetKV } from "@/lib/kv";
import { getQuota } from "@/lib/quota";
import type { Caller } from "@/lib/auth";
import { POST as analyze } from "@/app/api/analyze/route";
import { POST as tailor } from "@/app/api/tailor/route";

const IP = "5.5.5.5";
const ANON = "charging-test-anon";
const caller: Caller = { kind: "anon", anonId: ANON };

const used = async () => (await getQuota(caller, IP)).used;

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

describe("charging", () => {
  beforeEach(() => {
    resetKV();
    vi.mocked(callLLM).mockReset();
    vi.mocked(callLLM).mockResolvedValue({} as never);
    delete process.env.BETA_ACCESS_CODES;
  });

  it("charges one unit for a successful analyze", async () => {
    const res = await analyze(post("https://x/api/analyze", inputs("r1")));
    expect(res.status).toBe(200);
    expect(await used()).toBe(1);
  });

  it("charges nothing when the LLM call fails", async () => {
    vi.mocked(callLLM).mockRejectedValue(new Error("upstream down"));
    const res = await analyze(post("https://x/api/analyze", inputs("r2")));
    expect(res.status).toBe(502);
    expect(await used()).toBe(0);
  });

  it("charges nothing for a malformed body", async () => {
    const res = await analyze(post("https://x/api/analyze", { runId: "r3" }));
    expect(res.status).toBe(400);
    expect(await used()).toBe(0);
  });

  // THE invariant this task exists for: analyze + tailor sharing one runId is
  // one run. Task 8 makes the client send a shared id; this locks it in.
  it("charges one unit total for analyze + tailor sharing a runId", async () => {
    await Promise.all([
      analyze(post("https://x/api/analyze", inputs("shared"))),
      tailor(post("https://x/api/tailor", inputs("shared"))),
    ]);
    expect(await used()).toBe(1);
  });

  it("treats two requests with no shared runId as two runs", async () => {
    await analyze(post("https://x/api/analyze", inputs()));
    await tailor(post("https://x/api/tailor", inputs()));
    expect(await used()).toBe(2);
  });

  it("returns 402 and charges nothing once exhausted", async () => {
    for (let i = 0; i < 5; i++) {
      await analyze(post("https://x/api/analyze", inputs(`fill-${i}`)));
    }
    expect(await used()).toBe(5);
    const res = await analyze(post("https://x/api/analyze", inputs("over")));
    expect(res.status).toBe(402);
    expect(await used()).toBe(5);
  });

  it("charges nothing for a beta caller", async () => {
    process.env.BETA_ACCESS_CODES = "letmein";
    const res = await analyze(
      post("https://x/api/analyze", inputs("beta"), { "x-access-code": "letmein" }),
    );
    expect(res.status).toBe(200);
    expect(await used()).toBe(0);
  });

  it("401s on a present-but-invalid bearer token, before any LLM call", async () => {
    const res = await analyze(
      post("https://x/api/analyze", inputs("bad"), { authorization: "Bearer nope" }),
    );
    expect(res.status).toBe(401);
    expect(vi.mocked(callLLM)).not.toHaveBeenCalled();
    expect(await used()).toBe(0);
  });
});
