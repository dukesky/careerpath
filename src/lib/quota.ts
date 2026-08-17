import { getKV } from "./kv";
import { callerKey, type Caller } from "./auth";

/**
 * Business quota (separate from the abuse rate limit in rate-limit.ts).
 *
 * One "run" = one analyze + tailor flow. Both endpoints send the same client-
 * generated runId; the first SUCCESSFUL one charges, the other does not.
 *
 * Reusing that runId again refines the same result for free, up to
 * FREE_REFINES times, so a user can answer a gap the analysis found without
 * paying twice. Free of the caller's tier only — the per-IP ceiling still
 * counts every generate.
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
/**
 * How long a runId stays refinable.
 *
 * MUST stay well above a working session. The panel caches results for weeks
 * and offers to refine a posting long after the run; at the ten minutes this
 * used to be, a user returning the next day would be charged for a
 * refinement the product tells them is free, with nothing on screen to
 * explain it. There is a test asserting the floor.
 */
export const RUN_TTL_SECONDS = 48 * 60 * 60;

/**
 * `remaining` and `exhausted` are authoritative — always use these to decide
 * whether a caller may proceed. `used` and `limit` describe the caller's own
 * tier only, so when the per-IP ceiling is what's actually binding, the state
 * can legitimately read `{ limit: 5, used: 0, remaining: 0 }`. Consumers must
 * never derive `limit - used` as a substitute for `remaining`.
 */
export interface QuotaState {
  limit: number;
  used: number;
  remaining: number;
  exhausted: boolean;
}

/** A generate has exactly two legs: analyze and tailor. */
const LEGS_PER_GENERATE = 2;

/**
 * How many times a charged generate may be re-run for free.
 *
 * Refining a posting with supplementary experience must not cost a second
 * unit — but "free" cannot mean "unmetered". Extension code ships publicly
 * and is trivially unpackable, so an unbounded free-ride on a reused runId
 * would let one attacker-chosen id buy uncharged LLM calls until the marker
 * expired. This bound is what keeps that closed. Raising it raises the worst
 * case per IP per day proportionally.
 */
const FREE_REFINES = 2;

const MAX_FREE_LEGS = LEGS_PER_GENERATE * (1 + FREE_REFINES);

/** UTC calendar day, so a "daily" allowance is well-defined server-side. */
function dayKey(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

interface Tier {
  key: string;
  limit: number;
  ttl: number;
}

function tierFor(caller: Caller, ip: string): Tier {
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
      // resolveCaller yields anonId: "" whenever the header is absent — a bot,
      // a direct API call, an extension that hasn't minted a token yet. Keying
      // those on `quota:anon:` would put every one of them in a SINGLE global
      // bucket, so five stray requests exhaust it and every header-less caller
      // worldwide reads 0 remaining for the next 30 days. Fall back to the IP,
      // at the same allowance a normal anonymous visitor gets — so omitting
      // the header is never more generous than sending one.
      return {
        key: caller.anonId
          ? `quota:anon:${caller.anonId}`
          : `quota:anon:ip:${ip}`,
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
  const tier = tierFor(caller, ip);
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

  if (seen > 1 && seen <= MAX_FREE_LEGS) {
    // Inside the free window: the second leg of the charged generate, or
    // either leg of a free refinement. The caller's TIER is not charged —
    // that is the feature. The per-IP ceiling still is, once per generate,
    // because it bounds spend rather than rationing a user; skipping it here
    // would silently raise the real ceiling to (1 + FREE_REFINES) times
    // DAILY_IP_LIMIT.
    //
    // KNOWN IMPRECISION, accepted: this parity test assumes legs arrive in
    // pairs. They do not always — if analyze fails while tailor succeeds only
    // one leg is counted, and every later pair is shifted by one, so the IP
    // charge can land on a refinement's second leg instead of its first. The
    // security-relevant property is MAX_FREE_LEGS, which holds regardless of
    // parity; exact IP accounting under partial failure is not worth tracking
    // leg identity server-side.
    if (seen % LEGS_PER_GENERATE === 1 && hasIp(ip)) {
      await kv.incr(ipKey(ip), DAY_TTL_SECONDS);
    }
    return getQuota(caller, ip);
  }

  // Past the free window this is a REPLAYED runId. Charge normally.
  const tier = tierFor(caller, ip);
  const ipCounts = hasIp(ip);
  const [used, ipUsed] = await Promise.all([
    kv.incr(tier.key, tier.ttl),
    ipCounts ? kv.incr(ipKey(ip), DAY_TTL_SECONDS) : Promise.resolve(0),
  ]);
  return toState(tier.limit, used, ipUsed, ipCounts);
}
