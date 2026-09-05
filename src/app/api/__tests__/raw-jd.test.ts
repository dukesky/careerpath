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

const IP = "7.7.7.7";
const ANON = "raw-jd-test-anon";

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

describe.each([
  ["/api/analyze", analyze],
  ["/api/tailor", tailor],
])("POST %s — JD input shape", (url, route) => {
  beforeEach(() => {
    resetKV();
    vi.mocked(callLLM).mockReset();
    vi.mocked(callLLM).mockResolvedValue({} as never);
    delete process.env.BETA_ACCESS_CODES;
  });

  // The point of the whole change: the client can skip the serial parse hop
  // and hand us the posting it already has.
  it("accepts jdText and passes it through as a raw-text block", async () => {
    const res = await route(
      post(`https://x${url}`, { ...resume, jdText: "We need Kubernetes and Go." }),
    );

    expect(res.status).toBe(200);
    expect(sentUserMessage()).toContain("JOB DESCRIPTION (raw text)");
    expect(sentUserMessage()).toContain("We need Kubernetes and Go.");
  });

  // structuredJD is the better input when the client has it (a parse already
  // ran), so it wins rather than racing an ambiguous precedence.
  it("prefers structuredJD when both are supplied", async () => {
    await route(
      post(`https://x${url}`, {
        ...resume,
        structuredJD: { company: "Acme" },
        jdText: "raw text that must not be used",
      }),
    );

    expect(sentUserMessage()).toContain("JOB DESCRIPTION (JSON)");
    expect(sentUserMessage()).not.toContain("raw text that must not be used");
  });

  it("400s when neither structuredJD nor jdText is supplied", async () => {
    const res = await route(post(`https://x${url}`, resume));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Missing structuredJD or jdText." });
    expect(vi.mocked(callLLM)).not.toHaveBeenCalled();
  });

  it("400s on a blank jdText rather than sending an empty JD", async () => {
    const res = await route(post(`https://x${url}`, { ...resume, jdText: "   \n " }));

    expect(res.status).toBe(400);
    expect(vi.mocked(callLLM)).not.toHaveBeenCalled();
  });

  // Cost control: raw JD text is unbounded user input on a paid path.
  it("caps jdText at MAX_JD_CHARS", async () => {
    await route(post(`https://x${url}`, { ...resume, jdText: "x".repeat(MAX_JD_CHARS + 500) }));

    expect(sentUserMessage()).toContain("x".repeat(MAX_JD_CHARS));
    expect(sentUserMessage()).not.toContain("x".repeat(MAX_JD_CHARS + 1));
  });

  it("still rejects a missing resume first", async () => {
    const res = await route(post(`https://x${url}`, { jdText: "We need Go." }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Missing structuredResume." });
  });
});
