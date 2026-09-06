import { getKV } from "./kv";
import { callerKey, type Caller } from "./auth";

/**
 * Business quota (separate from the abuse rate limit in rate-limit.ts).
 *
 * One "run" = one analyze + tailor flow. Both endpoints send the same client-
 * generated runId; the first SUCCESSFUL one charges, the other does not.
 *
 * Reusing that runId again re-runs the same result for free while the free
 * window (MAX_FREE_LEGS) holds, so a user can answer a gap the analysis found
 * without paying twice. Free of the caller's tier only — the per-IP ceiling
 * still counts every generate.
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
 * The number of free refinements MAX_FREE_LEGS is SIZED for — not the number
 * a run actually gets. Read the arithmetic below before touching it.
 *
 * Refining a posting with supplementary experience must not cost a second
 * unit — but "free" cannot mean "unmetered". Extension code ships publicly
 * and is trivially unpackable, so an unbounded free-ride on a reused runId
 * would let one attacker-chosen id buy uncharged LLM calls until the marker
 * expired. The bound that keeps that closed is MAX_FREE_LEGS, in LEGS. This
 * constant only feeds it.
 *
 * WHAT A RUN ACTUALLY GETS. The window is 8 legs wide and the charged generate
 * spends 2 of them, leaving 6 free. Nothing reserves one of those for the
 * repair leg, and a run that never repairs — the common case — spends the 6 on
 * three refine PAIRS. So a no-repair run gets THREE free refinements, one more
 * than this constant's name suggests, and is worth 4 generates for the price of
 * one. A run that does repair spends leg 3 on it, gets two full free refines
 * (legs 4-7), and a third that straddles the edge: its first leg is free (8)
 * and its second charges (9 — past the window and odd, so the pair rule below
 * does not wave it through).
 *
 * That third refinement is free but not fully served: the rescore route's own
 * MAX_RESCORES_PER_RUN is 4, so its measurement is refused and the user sees
 * the tailor model's projection instead of a measured number. The two ceilings
 * count different units and are deliberately not derived from each other (see
 * that constant's note), so a change here does not move that one.
 *
 * WHAT RAISING IT COSTS, precisely — because the obvious guess is wrong: NOT
 * the per-IP ceiling. The IP counter below fires once per generate for any
 * value of FREE_REFINES, so LLM legs per IP per day stay at
 * 2 * DAILY_IP_LIMIT. What scales is the caller's TIER: a tier of N buys up to
 * 4N generates' worth of LLM work. For callers the platform gives no IP for
 * (see hasIp), the tier is the ONLY bound. Note the routes gate on
 * `exhausted` BEFORE doing the work, and `exhausted` reads the tier counter a
 * refinement does not charge — so the LAST charged run of an allowance gets no
 * refinements at all, and the real worth is 4N - 3 generates, not 4N.
 * Closing that would mean letting the routes skip the gate when the marker
 * exists and is below MAX_FREE_LEGS, which is safe because consumeRun enforces
 * the bound regardless — deliberately not done here.
 */
const FREE_REFINES = 2;

/**
 * The repair leg: ONE extra tailor, and only a tailor.
 *
 * When the client measures its rewrite as having lost a requirement it rewrites
 * once more against the gap matrix (extension/src/lib/run.ts's repair leg). That
 * call reuses the runId, so it lands here as an extra leg — an ODD one, since a
 * generate is a pair and this is a single. It is deliberately not made a
 * refinement's worth of allowance: the repair fires at most once per charged
 * generate (`repaired` guards recursion and the auto-refine tail), and a refine
 * run never repairs at all.
 */
const REPAIR_LEGS = 1;

/**
 * The free window, in legs: 8. THIS is the security bound — the one number a
 * reused runId cannot spend past.
 *
 * The expression below reads as "a repairing run's worst case, rounded up to a
 * pair":
 *   generate            2 (analyze + tailor)
 * + repair              1 (tailor only)
 * + 2 free refines      4 (analyze + tailor each)
 *   ------------------------------------------
 *                       7, rounded to 8
 *
 * The rounding is the parity rule below stated honestly: legs are charged in
 * PAIRS, and at an odd bound of 7 the eighth leg would be the second half of a
 * pair, which `seen > MAX_FREE_LEGS && !isFirstLegOfGenerate` waves through
 * uncharged anyway. A bound of 7 and a bound of 8 are the same window for that
 * run.
 *
 * They are NOT the same window for a run that never repairs, and that is the
 * common case. Nothing holds leg 3 in reserve for a repair that never comes:
 * the run simply spends legs 3-8 on three refine pairs, so the eighth leg is
 * not slack, it is the second half of a THIRD free refinement. See FREE_REFINES
 * above for what that is worth per tier. Raising this past an even count widens
 * the free ride by a whole refinement each time, not by a leg.
 */
const MAX_FREE_LEGS = LEGS_PER_GENERATE * (1 + FREE_REFINES) + REPAIR_LEGS + 1;

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
