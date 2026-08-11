import { getKV } from "./kv";
import { callerKey, type Caller } from "./auth";

/**
 * Business quota (separate from the abuse rate limit in rate-limit.ts).
 *
 * One "run" = one analyze + tailor flow. Both endpoints send the same client-
 * generated runId; the first SUCCESSFUL one charges, the other does not.
 *
 * A caller is blocked when EITHER its tier counter OR the per-IP ceiling is
 * exhausted.
 */

export const DAILY_USER_LIMIT = 5; // signed in, per day
export const DEVICE_TRIAL_LIMIT = 3; // extension, signed out, total
export const LEGACY_ANON_LIMIT = 5; // web, signed out, total — unchanged
export const DAILY_IP_LIMIT = 20; // abuse ceiling, per day

const DAY_TTL_SECONDS = 48 * 60 * 60;
const LONG_TTL_SECONDS = 30 * 24 * 60 * 60;
const RUN_TTL_SECONDS = 10 * 60;

export interface QuotaState {
  limit: number;
  used: number;
  remaining: number;
  exhausted: boolean;
}

/** UTC calendar day, so a "daily" allowance is well-defined server-side. */
function dayKey(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

interface Tier {
  key: string;
  limit: number;
  ttl: number;
}

function tierFor(caller: Caller): Tier {
  switch (caller.kind) {
    case "user":
      return {
        key: `quota:user:${caller.userId}:${dayKey()}`,
        limit: DAILY_USER_LIMIT,
        ttl: DAY_TTL_SECONDS,
      };
    case "device":
      return {
        key: `quota:device:${caller.deviceId}`,
        limit: DEVICE_TRIAL_LIMIT,
        ttl: LONG_TTL_SECONDS,
      };
    case "anon":
      return {
        key: `quota:anon:${caller.anonId}`,
        limit: LEGACY_ANON_LIMIT,
        ttl: LONG_TTL_SECONDS,
      };
  }
}

function hasIp(ip: string): boolean {
  return Boolean(ip) && ip !== "unknown";
}

const ipKey = (ip: string) => `quota:ip:${ip}:${dayKey()}`;

function toState(limit: number, used: number, ipUsed: number, ipCounts: boolean): QuotaState {
  const tierRemaining = Math.max(0, limit - used);
  const ipRemaining = ipCounts
    ? Math.max(0, DAILY_IP_LIMIT - ipUsed)
    : Number.POSITIVE_INFINITY;
  const remaining = Math.min(tierRemaining, ipRemaining);
  return { limit, used, remaining, exhausted: remaining <= 0 };
}

export async function getQuota(caller: Caller, ip: string): Promise<QuotaState> {
  const kv = getKV();
  const tier = tierFor(caller);
  const ipCounts = hasIp(ip);
  const [used, ipUsed] = await Promise.all([
    kv.getCount(tier.key),
    ipCounts ? kv.getCount(ipKey(ip)) : Promise.resolve(0),
  ]);
  return toState(tier.limit, used, ipUsed, ipCounts);
}

/**
 * Charge one unit for `runId`, at most once. Call ONLY after the work
 * succeeded. Returns the resulting quota state either way.
 */
export async function consumeRun(
  caller: Caller,
  ip: string,
  runId: string,
): Promise<QuotaState> {
  const kv = getKV();
  const marker = `run:${callerKey(caller)}:${runId}`;

  // incr is atomic: exactly one caller sees 1, so exactly one charges.
  const seen = await kv.incr(marker, RUN_TTL_SECONDS);
  if (seen > 1) return getQuota(caller, ip);

  const tier = tierFor(caller);
  const ipCounts = hasIp(ip);
  const [used, ipUsed] = await Promise.all([
    kv.incr(tier.key, tier.ttl),
    ipCounts ? kv.incr(ipKey(ip), DAY_TTL_SECONDS) : Promise.resolve(0),
  ]);
  return toState(tier.limit, used, ipUsed, ipCounts);
}
