import { getKV } from "./kv";
import type { Identity } from "./identity";

/**
 * Anonymous free-usage quota (business logic — separate from rate limiting).
 *
 * Each identity gets a fixed number of free "tailor" runs (one analyze+tailor
 * flow = one run). Quota is tracked against BOTH the anonId and the IP, and is
 * considered exhausted if EITHER has hit the limit — so clearing localStorage
 * alone does not reset it. Designed to be swapped for a paid credits system:
 * replace the counter reads/writes here with a credits ledger.
 */

export const FREE_TAILOR_LIMIT = 5;
const QUOTA_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

export interface QuotaState {
  limit: number;
  used: number;
  remaining: number;
  exhausted: boolean;
}

const anonKey = (id: string) => `quota:anon:${id}`;
const ipKey = (ip: string) => `quota:ip:${ip}`;

function toState(anonCount: number, ipCount: number): QuotaState {
  const used = Math.max(anonCount, ipCount);
  const remaining = Math.max(0, FREE_TAILOR_LIMIT - used);
  return { limit: FREE_TAILOR_LIMIT, used, remaining, exhausted: remaining <= 0 };
}

export async function getQuota(identity: Identity): Promise<QuotaState> {
  const kv = getKV();
  const [anon, ip] = await Promise.all([
    identity.anonId ? kv.getCount(anonKey(identity.anonId)) : Promise.resolve(0),
    identity.ip && identity.ip !== "unknown"
      ? kv.getCount(ipKey(identity.ip))
      : Promise.resolve(0),
  ]);
  return toState(anon, ip);
}

/** Consume one run against both the anonId and the IP. */
export async function consumeQuota(identity: Identity): Promise<QuotaState> {
  const kv = getKV();
  const [anon, ip] = await Promise.all([
    identity.anonId
      ? kv.incr(anonKey(identity.anonId), QUOTA_TTL_SECONDS)
      : Promise.resolve(0),
    identity.ip && identity.ip !== "unknown"
      ? kv.incr(ipKey(identity.ip), QUOTA_TTL_SECONDS)
      : Promise.resolve(0),
  ]);
  return toState(anon, ip);
}
