import OpenAI from "openai";
import { recordLLMCall, withStats } from "./llm-stats";

/**
 * Thin wrapper around OpenRouter (OpenAI-compatible API).
 *
 * All model routing lives in ONE place (MODEL_MAP / QUALITY_MODELS below) so
 * swapping a model is a one-line change.
 */

export type LLMTask = "parse" | "parse_jd" | "analyze" | "tailor" | "ocr";
export type Quality = "fast" | "quality";
export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

// ---------------------------------------------------------------------------
// Model routing — the single source of truth. Placeholders are easy to change.
// ---------------------------------------------------------------------------

const MODEL_MAP: Record<LLMTask, string> = {
  parse: "deepseek/deepseek-chat", // resume parsing — unchanged
  parse_jd: "anthropic/claude-haiku-4.5", // on the critical path; must be fast
  analyze: "anthropic/claude-sonnet-4.6",
  tailor: "anthropic/claude-sonnet-4.6",
  ocr: "anthropic/claude-sonnet-4.6", // vision-capable; hardcoded, ignores `quality`
};

// The `quality` flag only overrides analyze/tailor. OCR is always the map value.
// quality → latest Sonnet; fast → latest Haiku.
const QUALITY_MODELS: Record<Quality, string> = {
  fast: "anthropic/claude-haiku-4.5",
  quality: "anthropic/claude-sonnet-4.6",
};

// Sensible default sampling temperature per task.
//
// `analyze` is 0 deliberately. It is a judgment task whose output includes a
// 0-100 match score the panel shows as a "before" number, and at 0.3 the same
// resume against the same posting scored 72 on one run and 62 on the next —
// which read to the user as "adding information made my resume worse".
// Reproducibility is the property worth having here; raise this and that
// drift comes back.
//
// `tailor` stays at 0.4 even though it also emits a score, because the same
// call writes the rewritten prose. Cooling it to stabilise one number would
// flatten the writing, which is the thing the product is actually for.
const DEFAULT_TEMPERATURE: Record<LLMTask, number> = {
  parse: 0.1,
  parse_jd: 0.1,
  analyze: 0,
  tailor: 0.4,
  ocr: 0,
};

function resolveModel(task: LLMTask, quality?: Quality): string {
  if (quality && (task === "analyze" || task === "tailor")) {
    return QUALITY_MODELS[quality];
  }
  return MODEL_MAP[task];
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

let cachedClient: OpenAI | null = null;

function getClient(): OpenAI {
  if (cachedClient) return cachedClient;
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENROUTER_API_KEY is not set. Add it to .env.local (see .env.example).",
    );
  }
  cachedClient = new OpenAI({
    apiKey,
    baseURL: "https://openrouter.ai/api/v1",
    defaultHeaders: {
      // Optional OpenRouter attribution headers.
      "HTTP-Referer": "https://github.com/dukesky/careerpath",
      "X-Title": "career-path",
    },
  });
  return cachedClient;
}

// ---------------------------------------------------------------------------
// Message building (attaches images to the final user message for vision)
// ---------------------------------------------------------------------------

function lastUserIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return i;
  }
  return -1;
}

function toOpenAIMessages(
  messages: ChatMessage[],
  images?: string[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const base: OpenAI.Chat.Completions.ChatCompletionMessageParam[] =
    messages.map((m) => ({ role: m.role, content: m.content }));

  if (!images || images.length === 0) return base;

  const idx = lastUserIndex(messages);
  if (idx === -1) return base;

  const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
    { type: "text", text: messages[idx].content },
    ...images.map(
      (url): OpenAI.Chat.Completions.ChatCompletionContentPart => ({
        type: "image_url",
        image_url: { url },
      }),
    ),
  ];
  base[idx] = { role: "user", content: parts };
  return base;
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

/**
 * Strip ```json ... ``` / ``` ... ``` fences and surrounding prose.
 *
 * Exported for the streaming routes: `streamLLM` hands back raw text, so the
 * caller has to do the fence-stripping `callLLM`'s JSON mode does internally.
 */
export function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/i);
  if (fenced) return fenced[1].trim();
  // Fall back to the outermost {...} or [...] block if there is stray prose.
  const firstObj = trimmed.indexOf("{");
  const firstArr = trimmed.indexOf("[");
  const starts = [firstObj, firstArr].filter((i) => i >= 0);
  if (starts.length > 0) {
    const start = Math.min(...starts);
    const openChar = trimmed[start];
    const closeChar = openChar === "{" ? "}" : "]";
    const end = trimmed.lastIndexOf(closeChar);
    if (end > start) return trimmed.slice(start, end + 1).trim();
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CallLLMOptions {
  task: LLMTask;
  messages: ChatMessage[];
  /** Data URLs or public image URLs, attached to the final user message. */
  images?: string[];
  /** Overrides the analyze/tailor model. Ignored for parse/ocr. */
  quality?: Quality;
  /** When true, parse the response as JSON (fence-stripping + one retry). */
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
}

// Text mode returns a string; JSON mode returns the parsed value (typed by T).
export async function callLLM(
  options: CallLLMOptions & { json?: false | undefined },
): Promise<string>;
export async function callLLM<T = unknown>(
  options: CallLLMOptions & { json: true },
): Promise<T>;
export async function callLLM<T = unknown>(
  options: CallLLMOptions,
): Promise<string | T> {
  const { task, messages, images, quality, json, temperature, maxTokens } =
    options;
  const model = resolveModel(task, quality);
  const temp = temperature ?? DEFAULT_TEMPERATURE[task];

  async function complete(
    msgs: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  ): Promise<string> {
    return withStats({ task, model, quality }, async () => {
      const res = await getClient().chat.completions.create({
        model,
        messages: msgs,
        temperature: temp,
        ...(maxTokens ? { max_tokens: maxTokens } : {}),
      });
      return {
        result: res.choices[0]?.message?.content?.trim() ?? "",
        promptTokens: res.usage?.prompt_tokens ?? 0,
        completionTokens: res.usage?.completion_tokens ?? 0,
      };
    });
  }

  const openAIMessages = toOpenAIMessages(messages, images);

  if (!json) {
    return complete(openAIMessages);
  }

  // JSON mode: strip fences, parse, and retry once by feeding the error back.
  const first = await complete(openAIMessages);
  try {
    return JSON.parse(stripCodeFences(first)) as T;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const retryMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      ...openAIMessages,
      { role: "assistant", content: first },
      {
        role: "user",
        content:
          `Your previous reply could not be parsed as JSON (${reason}). ` +
          "Reply again with ONLY valid, complete JSON — no code fences, no commentary.",
      },
    ];
    const second = await complete(retryMessages);
    return JSON.parse(stripCodeFences(second)) as T; // let a second failure throw
  }
}

export interface StreamLLMOptions {
  task: LLMTask;
  messages: ChatMessage[];
  /** Overrides the analyze/tailor model. Ignored for parse/ocr. */
  quality?: Quality;
  temperature?: number;
  maxTokens?: number;
}

/**
 * Streams raw text deltas; returns the full concatenated text.
 *
 * No JSON handling here — callers own parsing (routes normalize the final text
 * with `stripCodeFences` and fall back to the buffered `callLLM` retry on a
 * parse failure). No image support either: streaming is for the long text/JSON
 * generations, and OCR stays on the buffered path.
 */
export async function* streamLLM(
  options: StreamLLMOptions,
): AsyncGenerator<string, string> {
  const { task, messages, quality, temperature, maxTokens } = options;
  const model = resolveModel(task, quality);
  const temp = temperature ?? DEFAULT_TEMPERATURE[task];

  // Timed by hand rather than through `withStats`, which wants one awaitable to
  // wrap. A stream's wall time spans the whole drain, so the clock starts
  // before the request and stops when the last chunk lands — wrapping the
  // already-resolved totals would record ~0ms into the same
  // `stats:{task}:{model}` aggregate the buffered calls feed.
  const started = Date.now();
  let full = "";
  let promptTokens = 0;
  let completionTokens = 0;

  // Recording is guarded and lives in the `finally` because there are THREE
  // ways out of this generator, not two: it settles, it throws, or the
  // consumer ends it early with gen.return() — which is what drainDeltas does
  // when the client disconnects. That third exit runs neither branch below,
  // so before this the calls that a disconnect cut short were the only ones
  // missing from the tally: real spend, invisible.
  let recorded = false;
  const record = async (ok: boolean) => {
    if (recorded) return;
    recorded = true;
    await recordLLMCall({
      task,
      model,
      quality,
      durationMs: Date.now() - started,
      // A failure reports zeros: whatever partial usage was in flight is not
      // something the aggregate should treat as delivered work.
      promptTokens: ok ? promptTokens : 0,
      completionTokens: ok ? completionTokens : 0,
      ok,
    });
  };

  try {
    const stream = await getClient().chat.completions.create({
      model,
      messages: toOpenAIMessages(messages),
      temperature: temp,
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
      stream: true,
      // OpenRouter only sends the usage chunk when this is asked for; without
      // it the stats below would record every streamed call as zero tokens.
      stream_options: { include_usage: true },
    });

    for await (const chunk of stream) {
      // The usage-bearing chunk arrives last and carries no content of its own.
      if (chunk.usage) {
        promptTokens = chunk.usage.prompt_tokens ?? 0;
        completionTokens = chunk.usage.completion_tokens ?? 0;
      }
      const delta = chunk.choices?.[0]?.delta?.content ?? "";
      if (delta) {
        full += delta;
        yield delta;
      }
    }
    await record(true);
  } catch (err) {
    // openai-node raises an APIError from inside the iterator whenever
    // OpenRouter surfaces an upstream error, so a mid-stream throw is a normal
    // path — count it, or streamed failures never reach the failure tally.
    await record(false);
    throw err;
  } finally {
    // Reached with nothing recorded only on the early-return path. The call
    // was made and the tokens burned up to the hang-up, so it counts as a
    // success with whatever usage had arrived — usually none, because the
    // usage chunk is the last one.
    await record(true);
  }

  return full;
}
