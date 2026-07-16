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

export function getKV(): KVStore {
  if (store) return store;
  const creds = resolveRedisCreds();
  store = creds ? new UpstashStore(creds.url, creds.token) : new MemoryStore();
  return store;
}

export function isRedisConfigured(): boolean {
  return resolveRedisCreds() !== null;
}
