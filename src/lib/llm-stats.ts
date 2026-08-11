import { getKV } from "./kv";

/**
 * LLM call instrumentation — the data behind "which model is fast enough".
 *
 * Two cheap channels: one structured log line per call (queryable in Vercel
 * logs) and a rolling Redis aggregate per task+model. Recording must never
 * break a user-facing request, so every failure here is swallowed.
 */

export interface LLMCallStats {
  task: string;
  model: string;
  quality?: string;
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
  ok: boolean;
}

const statsKey = (task: string, model: string) => `stats:${task}:${model}`;

export async function recordLLMCall(stats: LLMCallStats): Promise<void> {
  console.log(
    JSON.stringify({
      evt: "llm_call",
      task: stats.task,
      model: stats.model,
      quality: stats.quality ?? null,
      durationMs: stats.durationMs,
      promptTokens: stats.promptTokens,
      completionTokens: stats.completionTokens,
      ok: stats.ok,
    }),
  );

  // Read every field once, then write them concurrently. This sits in the hot
  // path of every LLM call, so it must cost two round-trip layers, not ten:
  // KVStore has no atomic hash-increment, and awaiting five sequential
  // read-modify-write pairs would add real latency to every request.
  //
  // Still read-modify-write, so concurrent calls can lose an increment. That
  // is deliberate: these are trend aggregates for model comparison, not
  // billing. The per-call console.log above is the exact record.
  //
  // No TTL: the key space is bounded by the number of (task, model) pairs —
  // a dozen keys, not one per user — so these never need to expire.
  try {
    const kv = getKV();
    const key = statsKey(stats.task, stats.model);
    const current = await kv.hgetall(key);
    const next = (field: string, by: number) =>
      String(Number(current[field] ?? 0) + by);

    await Promise.all([
      kv.hset(key, "calls", next("calls", 1)),
      kv.hset(key, "totalMs", next("totalMs", stats.durationMs)),
      kv.hset(key, "promptTokens", next("promptTokens", stats.promptTokens)),
      kv.hset(
        key,
        "completionTokens",
        next("completionTokens", stats.completionTokens),
      ),
      kv.hset(key, "failures", next("failures", stats.ok ? 0 : 1)),
    ]);
  } catch {
    // Never let instrumentation break a user request.
  }
}

/**
 * Time `fn`, record the outcome, and return its result. Records a failure and
 * rethrows if `fn` throws.
 */
export async function withStats<T>(
  meta: { task: string; model: string; quality?: string },
  fn: () => Promise<{ result: T; promptTokens: number; completionTokens: number }>,
): Promise<T> {
  const started = Date.now();
  try {
    const { result, promptTokens, completionTokens } = await fn();
    await recordLLMCall({
      ...meta,
      durationMs: Date.now() - started,
      promptTokens,
      completionTokens,
      ok: true,
    });
    return result;
  } catch (err) {
    await recordLLMCall({
      ...meta,
      durationMs: Date.now() - started,
      promptTokens: 0,
      completionTokens: 0,
      ok: false,
    });
    throw err;
  }
}
