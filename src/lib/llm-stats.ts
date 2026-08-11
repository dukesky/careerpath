import { getKV } from "./kv";

/**
 * LLM call instrumentation — the data behind "which model is fast enough".
 *
 * Two cheap channels: one structured log line per call (queryable in Vercel
 * logs) and a rolling Redis aggregate per task+model. Recording must never
 * break a user-facing request, so every failure here is swallowed.
 */

const STATS_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

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

/**
 * Read-modify-write, so concurrent calls can lose an increment. That is
 * deliberate: these are trend aggregates for model comparison, not billing.
 * The per-call console.log line is the exact record; this is the cheap rollup.
 */
async function bump(key: string, field: string, by: number): Promise<void> {
  const kv = getKV();
  const current = Number((await kv.hgetall(key))[field] ?? 0);
  await kv.hset(key, field, String(current + by));
}

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

  try {
    const key = statsKey(stats.task, stats.model);
    await bump(key, "calls", 1);
    await bump(key, "totalMs", stats.durationMs);
    await bump(key, "promptTokens", stats.promptTokens);
    await bump(key, "completionTokens", stats.completionTokens);
    await bump(key, "failures", stats.ok ? 0 : 1);
    // Touch a companion counter purely to attach a TTL to the aggregate.
    await getKV().incr(`${key}:ttl`, STATS_TTL_SECONDS);
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
