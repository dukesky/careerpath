import { Redis } from "@upstash/redis";

/**
 * Tiny KV abstraction shared by quota, rate-limit, and waitlist modules.
 * Backed by Upstash Redis when configured, otherwise an in-memory Map
 * (fine for local dev; not shared across serverless instances in prod).
 */
export interface KVStore {
  /** Atomic increment; sets TTL on first write. Returns the new count. */
  incr(key: string, ttlSeconds: number): Promise<number>;
  /** Current integer value (0 if absent/expired). */
  getCount(key: string): Promise<number>;
  /** Append to a list. */
  rpush(key: string, value: string): Promise<void>;
  /** Set a field in a hash (used for per-user saved-resume records). */
  hset(key: string, field: string, value: string): Promise<void>;
  /** All fields of a hash (empty object if absent). */
  hgetall(key: string): Promise<Record<string, string>>;
  /** Delete a field from a hash. */
  hdel(key: string, field: string): Promise<void>;
}

class UpstashStore implements KVStore {
  private redis: Redis;
  constructor(url: string, token: string) {
    this.redis = new Redis({ url, token });
  }
  async incr(key: string, ttlSeconds: number): Promise<number> {
    const n = await this.redis.incr(key);
    if (n === 1) await this.redis.expire(key, ttlSeconds);
    return n;
  }
  async getCount(key: string): Promise<number> {
    const v = await this.redis.get<number | string>(key);
    if (v == null) return 0;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  async rpush(key: string, value: string): Promise<void> {
    await this.redis.rpush(key, value);
  }
  async hset(key: string, field: string, value: string): Promise<void> {
    await this.redis.hset(key, { [field]: value });
  }
  async hgetall(key: string): Promise<Record<string, string>> {
    const v = await this.redis.hgetall<Record<string, string>>(key);
    // Upstash may auto-parse JSON values; coerce everything back to strings.
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v ?? {})) {
      out[k] = typeof val === "string" ? val : JSON.stringify(val);
    }
    return out;
  }
  async hdel(key: string, field: string): Promise<void> {
    await this.redis.hdel(key, field);
  }
}

class MemoryStore implements KVStore {
  private counters = new Map<string, { value: number; expires: number }>();
  private lists = new Map<string, string[]>();
  private hashes = new Map<string, Map<string, string>>();

  async incr(key: string, ttlSeconds: number): Promise<number> {
    const now = Date.now();
    const cur = this.counters.get(key);
    if (!cur || cur.expires <= now) {
      this.counters.set(key, { value: 1, expires: now + ttlSeconds * 1000 });
      return 1;
    }
    cur.value += 1;
    return cur.value;
  }
  async getCount(key: string): Promise<number> {
    const cur = this.counters.get(key);
    if (!cur || cur.expires <= Date.now()) return 0;
    return cur.value;
  }
  async rpush(key: string, value: string): Promise<void> {
    const arr = this.lists.get(key) ?? [];
    arr.push(value);
    this.lists.set(key, arr);
  }
  async hset(key: string, field: string, value: string): Promise<void> {
    const h = this.hashes.get(key) ?? new Map<string, string>();
    h.set(field, value);
    this.hashes.set(key, h);
  }
  async hgetall(key: string): Promise<Record<string, string>> {
    return Object.fromEntries(this.hashes.get(key) ?? new Map());
  }
  async hdel(key: string, field: string): Promise<void> {
    this.hashes.get(key)?.delete(field);
  }
}

let store: KVStore | null = null;

/**
 * Where the in-memory fallback actually lives: on `globalThis`, not in this
 * module's own scope.
 *
 * A module-level `new MemoryStore()` is one store per MODULE INSTANCE, and
 * that is not the same thing as one store per process. `next dev` bundles each
 * route handler separately, so /api/analyze, /api/quota and /api/rescore each
 * get their own copy of this module and their own Map — with the result that a
 * generate charges inside analyze's copy, `GET /api/quota` reads quota's copy
 * and answers `used: 0`, and /api/rescore looks for the run marker analyze
 * wrote and does not find it. Every one of those routes is behaving correctly;
 * they are simply not talking to the same store. It is invisible from the
 * outside except as "the counter never moves", which reads as a quota bug and
 * is not one — the evaluator's A7 is what finally surfaced it, as a 403 from a
 * marker gate whose marker had genuinely been written.
 *
 * Keying on `Symbol.for` puts it in the cross-realm registry, so every bundle
 * in the process finds the same object. This changes NOTHING in production
 * with Upstash configured (that branch is taken first) and nothing about the
 * warning below: across serverless instances the memory store is still wrong,
 * and still per-instance. It only makes "per-process" true where the process
 * really is the boundary — local dev, tests, and the evaluator harness.
 */
const MEMORY_STORE_KEY = Symbol.for("career-path.kv.memory-store");
type GlobalWithStore = typeof globalThis & { [MEMORY_STORE_KEY]?: KVStore };

function sharedMemoryStore(): KVStore {
  const g = globalThis as GlobalWithStore;
  g[MEMORY_STORE_KEY] ??= new MemoryStore();
  return g[MEMORY_STORE_KEY];
}

/**
 * Resolve REST credentials from either the Upstash-native names
 * (UPSTASH_REDIS_REST_URL/TOKEN) or the Vercel Marketplace names
 * (KV_REST_API_URL/TOKEN). Note: the read-only token can't incr/rpush, so we
 * never fall back to KV_REST_API_READ_ONLY_TOKEN.
 */
function resolveRedisCreds(): { url: string; token: string } | null {
  const url =
    process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  return url && token ? { url, token } : null;
}

/**
 * Warned once per PROCESS, not per store. "This deployment has no Redis" is a
 * fact about the environment, so resetKV() — which is test-only — deliberately
 * does not re-arm it.
 */
let warnedNoRedis = false;

export function getKV(): KVStore {
  if (store) return store;
  const creds = resolveRedisCreds();
  if (creds) {
    store = new UpstashStore(creds.url, creds.token);
    return store;
  }

  // Loud on purpose. The in-memory store is correct for local dev and WRONG in
  // production: analyze and tailor are concurrent serverless invocations that
  // land on different instances, so the runId marker they are supposed to
  // share is not shared at all. Every generate charges twice, the free
  // refinements a charged run is meant to buy never apply, and the per-model
  // timing rollups reset with the process instead of accumulating.
  //
  // None of that is visible from the outside, which is how it survived four
  // release cycles here. isRedisConfigured() below has existed for exactly
  // this check the whole time and was never called from anywhere — a silent
  // fallback is how a precondition becomes an outage nobody can see.
  if (!warnedNoRedis) {
    warnedNoRedis = true;
    console.warn(
      JSON.stringify({
        evt: "kv_no_redis_falling_back_to_memory",
        detail:
          "Set UPSTASH_REDIS_REST_URL/TOKEN (or KV_REST_API_URL/TOKEN). " +
          "Without them quota is per-process: generates double-charge across " +
          "instances and free refinements never apply.",
      }),
    );
  }
  store = sharedMemoryStore();
  return store;
}

/**
 * Test-only: drop the cached store so the next getKV() builds a fresh one.
 * Never call this from application code.
 *
 * Clears the process-global memory store as well as this module's reference to
 * it. Both are required: leaving the global in place would carry one test
 * file's counters into the next, since a vitest worker runs several files in
 * one process and `Symbol.for` deliberately reaches across module instances.
 */
export function resetKV(): void {
  store = null;
  delete (globalThis as GlobalWithStore)[MEMORY_STORE_KEY];
}

export function isRedisConfigured(): boolean {
  return resolveRedisCreds() !== null;
}
