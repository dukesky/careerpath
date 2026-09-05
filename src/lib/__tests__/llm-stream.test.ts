import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * streamLLM — the delta generator behind the streaming routes.
 *
 * The openai client and the stats recorder are both mocked: this test is about
 * the wrapper's contract (deltas out, full text returned, usage recorded from
 * the final chunk), not about the network or Redis.
 */

const { createMock, statsCalls } = vi.hoisted(() => ({
  createMock: vi.fn(),
  statsCalls: [] as Array<{
    meta: { task: string; model: string; quality?: string };
    payload: { result: string; promptTokens: number; completionTokens: number };
  }>,
}));

vi.mock("openai", () => ({
  default: class FakeOpenAI {
    chat = { completions: { create: createMock } };
  },
}));

vi.mock("@/lib/llm-stats", () => ({
  withStats: vi.fn(
    async (
      meta: { task: string; model: string; quality?: string },
      fn: () => Promise<{
        result: string;
        promptTokens: number;
        completionTokens: number;
      }>,
    ) => {
      const payload = await fn();
      statsCalls.push({ meta, payload });
      return payload.result;
    },
  ),
}));

import { streamLLM } from "@/lib/llm";

type Chunk = {
  choices?: Array<{ delta?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

/** A minimal stand-in for the SDK's Stream<ChatCompletionChunk>. */
function fakeStream(chunks: Chunk[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

const deltaChunk = (content: string): Chunk => ({
  choices: [{ delta: { content } }],
});

/** Drains the generator, returning both the yielded deltas and the return value. */
async function drain(gen: AsyncGenerator<string, string>) {
  const deltas: string[] = [];
  let step = await gen.next();
  while (!step.done) {
    deltas.push(step.value);
    step = await gen.next();
  }
  return { deltas, full: step.value };
}

describe("streamLLM", () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = "test-key";
    createMock.mockReset();
    statsCalls.length = 0;
  });

  it("yields each content delta and returns the concatenated text", async () => {
    createMock.mockResolvedValue(
      fakeStream([
        deltaChunk("Hello"),
        deltaChunk(", "),
        { choices: [{ delta: {} }] }, // a role-only / empty chunk is skipped
        deltaChunk("world"),
        { choices: [], usage: { prompt_tokens: 11, completion_tokens: 4 } },
      ]),
    );

    const { deltas, full } = await drain(
      streamLLM({
        task: "analyze",
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    expect(deltas).toEqual(["Hello", ", ", "world"]);
    expect(full).toBe("Hello, world");
  });

  it("asks the API for a stream with usage included", async () => {
    createMock.mockResolvedValue(fakeStream([deltaChunk("ok")]));

    await drain(
      streamLLM({
        task: "tailor",
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "u" },
        ],
        quality: "fast",
        temperature: 0.7,
        maxTokens: 900,
      }),
    );

    expect(createMock).toHaveBeenCalledTimes(1);
    const args = createMock.mock.calls[0][0];
    expect(args).toMatchObject({
      model: "anthropic/claude-haiku-4.5", // quality:"fast" overrides tailor
      temperature: 0.7,
      max_tokens: 900,
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(args.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "u" },
    ]);
  });

  it("records the call's usage through withStats once the stream ends", async () => {
    createMock.mockResolvedValue(
      fakeStream([
        deltaChunk("abc"),
        { choices: [], usage: { prompt_tokens: 120, completion_tokens: 34 } },
      ]),
    );

    await drain(
      streamLLM({
        task: "analyze",
        messages: [{ role: "user", content: "hi" }],
        quality: "quality",
      }),
    );

    expect(statsCalls).toHaveLength(1);
    expect(statsCalls[0].meta).toEqual({
      task: "analyze",
      model: "anthropic/claude-sonnet-4.6",
      quality: "quality",
    });
    expect(statsCalls[0].payload).toEqual({
      result: "abc",
      promptTokens: 120,
      completionTokens: 34,
    });
  });

  it("falls back to the task default temperature and omits max_tokens", async () => {
    createMock.mockResolvedValue(fakeStream([deltaChunk("x")]));

    await drain(
      streamLLM({ task: "analyze", messages: [{ role: "user", content: "q" }] }),
    );

    const args = createMock.mock.calls[0][0];
    expect(args.temperature).toBe(0); // analyze is deliberately deterministic
    expect(args).not.toHaveProperty("max_tokens");
  });
});
