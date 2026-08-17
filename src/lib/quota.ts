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
 * expired. This bound is what keeps that closed.
 *
 * What raising it costs, precisely — because the obvious guess is wrong: NOT
 * the per-IP ceiling. The IP counter below fires once per generate for any
 * value of FREE_REFINES, so LLM legs per IP per day stay at
 * 2 * DAILY_IP_LIMIT. What scales is the caller's TIER: a tier of N buys
 * N * (1 + FREE_REFINES) generates. For callers the platform gives no IP for
 * (see hasIp), the tier is the ONLY bound. Note the routes gate on
 * `exhausted` BEFORE doing the work, and `exhausted` reads the tier counter a
 * refinement does not charge — so the LAST charged run of an allowance gets no
 * refinements at all, and the real worth is
 * N * (1 + FREE_REFINES) - FREE_REFINES generates, not N * (1 + FREE_REFINES).
 * Closing that would mean letting the routes skip the gate when the marker
 * exists and is below MAX_FREE_LEGS, which is safe because consumeRun enforces
 * the bound regardless — deliberately not done here.
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

  // Legs pair up: an odd `seen` is a generate's first leg, an even one its
  // second. That pairing holds FOREVER — inside the free window and past it.
  // The window decides WHAT a leg charges, not WHETHER it charges.
  const isFirstLegOfGenerate = seen % LEGS_PER_GENERATE === 1;

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
    if (isFirstLegOfGenerate && hasIp(ip)) {
      await kv.incr(ipKey(ip), DAY_TTL_SECONDS);
    }
    return getQuota(caller, ip);
  }

  if (seen > MAX_FREE_LEGS && !isFirstLegOfGenerate) {
    // Past the window a reused runId is charged like any other — but it is
    // still a PAIR. Without this, both legs charge and one generate costs two
    // units, which only ever punishes a real user: an attacker would mint
    // fresh ids and pay the normal rate anyway, so double-charging replay
    // deters nothing. Charging once per pair here is exactly what a fresh
    // runId would cost.
    return getQuota(caller, ip);
  }

  // `seen === 1`, or the first leg of a generate past the free window.
  const tier = tierFor(caller, ip);
  const ipCounts = hasIp(ip);
  const [used, ipUsed] = await Promise.all([
    kv.incr(tier.key, tier.ttl),
    ipCounts ? kv.incr(ipKey(ip), DAY_TTL_SECONDS) : Promise.resolve(0),
  ]);
  return toState(tier.limit, used, ipUsed, ipCounts);
}
