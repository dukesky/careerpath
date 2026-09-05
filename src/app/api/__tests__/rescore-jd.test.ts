import { describe, it, expect, beforeEach, vi } from "vitest";

// Must be hoisted above the route imports.
vi.mock("@/lib/llm", () => ({ callLLM: vi.fn() }));
vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(async () => ({ userId: null })),
}));

import { callLLM } from "@/lib/llm";
import { resetKV } from "@/lib/kv";
import { MAX_JD_CHARS } from "@/lib/limits";
import { POST as analyze } from "@/app/api/analyze/route";
import { POST as tailor } from "@/app/api/tailor/route";
import { POST as rescore } from "@/app/api/rescore/route";

const IP = "8.8.8.8";
const ANON = "rescore-jd-test-anon";

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

/** The user message the route actually sent to the model. */
const sentUserMessage = () =>
  vi.mocked(callLLM).mock.calls.at(-1)?.[0].messages[1].content ?? "";

const resume = { structuredResume: { contact: { name: "A" } } };

/** A real charged generate, so the run marker the rescore gate reads exists. */
async function generate(runId: string) {
  const inputs = { ...resume, jdText: "We need Go.", runId };
  await analyze(post("https://x/api/analyze", inputs));
  await tailor(post("https://x/api/tailor", inputs));
}

/**
 * The extension no longer parses the JD, so it has no ParsedJD to hand this
 * route — only the raw posting text that analyze and tailor now take. The JD
 * INPUT is all that widens here: the instrument (analyze's own messages, empty
 * extraInfo, the analyze task, no temperature) is untouched, and rescore.test.ts
 * pins that separately.
 */
describe("POST /api/rescore — JD input shape", () => {
  beforeEach(() => {
    resetKV();
    vi.mocked(callLLM).mockReset();
    vi.mocked(callLLM).mockResolvedValue({ overall_match_score: 81 } as never);
    delete process.env.BETA_ACCESS_CODES;
  });

  it("accepts jdText and passes it through as a raw-text block", async () => {
    await generate("rj-raw");

    const res = await rescore(
      post("https://x/api/rescore", {
        ...resume,
        jdText: "We need Kubernetes and Go.",
        runId: "rj-raw",
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ score: 81 });
    expect(sentUserMessage()).toContain("JOB DESCRIPTION (raw text)");
    expect(sentUserMessage()).toContain("We need Kubernetes and Go.");
  });

  it("prefers structuredJD when both are supplied", async () => {
    await generate("rj-both");

    await rescore(
      post("https://x/api/rescore", {
        ...resume,
        structuredJD: { company: "Acme" },
        jdText: "raw text that must not be used",
        runId: "rj-both",
      }),
    );

    expect(sentUserMessage()).toContain("JOB DESCRIPTION (JSON)");
    expect(sentUserMessage()).not.toContain("raw text that must not be used");
  });

  it("400s when neither structuredJD nor jdText is supplied", async () => {
    await generate("rj-none");

    const res = await rescore(post("https://x/api/rescore", { ...resume, runId: "rj-none" }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Missing structuredJD or jdText." });
    // Two calls from the generate above and nothing since.
    expect(vi.mocked(callLLM)).toHaveBeenCalledTimes(2);
  });

  it("400s on a blank jdText rather than scoring against an empty JD", async () => {
    await generate("rj-blank");

    const res = await rescore(
      post("https://x/api/rescore", { ...resume, jdText: "   \n ", runId: "rj-blank" }),
    );

    expect(res.status).toBe(400);
    expect(vi.mocked(callLLM)).toHaveBeenCalledTimes(2);
  });

  // Cost control: raw JD text is unbounded user input on an LLM path, and this
  // route's per-run ceiling bounds the number of calls, not their size.
  it("caps jdText at MAX_JD_CHARS", async () => {
    await generate("rj-cap");

    await rescore(
      post("https://x/api/rescore", {
        ...resume,
        jdText: "x".repeat(MAX_JD_CHARS + 500),
        runId: "rj-cap",
      }),
    );

    expect(sentUserMessage()).toContain("x".repeat(MAX_JD_CHARS));
    expect(sentUserMessage()).not.toContain("x".repeat(MAX_JD_CHARS + 1));
  });

  it("still rejects a missing resume first", async () => {
    const res = await rescore(
      post("https://x/api/rescore", { jdText: "We need Go.", runId: "rj-resume" }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Missing structuredResume." });
  });
});
