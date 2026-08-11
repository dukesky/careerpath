import { NextResponse } from "next/server";
import { getKV } from "./kv";

/**
 * Per-IP rate limiting (abuse protection — a DIFFERENT concern from the
 * business quota in quota.ts). Fixed window: MAX_REQUESTS per WINDOW_SECONDS.
 */

const WINDOW_SECONDS = 60;
const MAX_REQUESTS = 30;

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfter: number;
}

export interface RateLimitScope {
  /** Key namespace. Omitted = the shared request bucket. */
  scope?: string;
  max?: number;
  windowSeconds?: number;
}

/**
 * Identity minting: a device token lasts 24h, so a healthy client mints two
 * or three a day. Kept deliberately loose enough for many users behind one
 * NAT, and still ~100x tighter than the shared bucket.
 */
export const DEVICE_TOKEN_RATE_LIMIT: RateLimitScope = {
  scope: "devicetoken",
  max: 20,
  windowSeconds: 60 * 60,
};

export async function checkRateLimit(
  ip: string,
  opts: RateLimitScope = {},
): Promise<RateLimitResult> {
  const max = opts.max ?? MAX_REQUESTS;
  const windowSeconds = opts.windowSeconds ?? WINDOW_SECONDS;
  if (!ip || ip === "unknown") {
    return { ok: true, remaining: max, retryAfter: 0 };
  }
  const key = opts.scope ? `ratelimit:${opts.scope}:${ip}` : `ratelimit:${ip}`;
  const count = await getKV().incr(key, windowSeconds);
  const remaining = Math.max(0, max - count);
  return {
    ok: count <= max,
    remaining,
    retryAfter: count > max ? windowSeconds : 0,
  };
}

/** Returns a 429 response when the IP is over the limit, else null. */
export async function rateLimitResponse(
  ip: string,
  opts: RateLimitScope = {},
): Promise<Response | null> {
  const result = await checkRateLimit(ip, opts);
  if (result.ok) return null;
  return NextResponse.json(
    { error: "Too many requests. Please slow down and try again shortly." },
    { status: 429, headers: { "Retry-After": String(result.retryAfter) } },
  );
}
