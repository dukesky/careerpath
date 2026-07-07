import OpenAI from "openai";

/**
 * Thin wrapper around OpenRouter (OpenAI-compatible API).
 *
 * All model routing lives in ONE place (MODEL_MAP / QUALITY_MODELS below) so
 * swapping a model is a one-line change.
 */

export type LLMTask = "parse" | "analyze" | "tailor" | "ocr";
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
  parse: "deepseek/deepseek-chat", // placeholder — swap freely
  analyze: "anthropic/claude-sonnet-4.5",
  tailor: "anthropic/claude-sonnet-4.5",
  ocr: "anthropic/claude-sonnet-4.5", // vision-capable; hardcoded, ignores `quality`
};

// The `quality` flag only overrides analyze/tailor. OCR is always the map value.
const QUALITY_MODELS: Record<Quality, string> = {
  fast: "anthropic/claude-haiku-4.5",
  quality: "anthropic/claude-sonnet-4.5",
};

// Sensible default sampling temperature per task.
const DEFAULT_TEMPERATURE: Record<LLMTask, number> = {
  parse: 0.1,
  analyze: 0.3,
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

/** Strip ```json ... ``` / ``` ... ``` fences and surrounding prose. */
function stripCodeFences(text: string): string {
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
    const res = await getClient().chat.completions.create({
      model,
      messages: msgs,
      temperature: temp,
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
    });
    return res.choices[0]?.message?.content?.trim() ?? "";
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
