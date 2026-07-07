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
}

class MemoryStore implements KVStore {
  private counters = new Map<string, { value: number; expires: number }>();
  private lists = new Map<string, string[]>();

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
