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

export async function checkRateLimit(ip: string): Promise<RateLimitResult> {
  if (!ip || ip === "unknown") {
    return { ok: true, remaining: MAX_REQUESTS, retryAfter: 0 };
  }
  const count = await getKV().incr(`ratelimit:${ip}`, WINDOW_SECONDS);
  const remaining = Math.max(0, MAX_REQUESTS - count);
  return {
    ok: count <= MAX_REQUESTS,
    remaining,
    retryAfter: count > MAX_REQUESTS ? WINDOW_SECONDS : 0,
  };
}

/** Returns a 429 response when the IP is over the limit, else null. */
export async function rateLimitResponse(ip: string): Promise<Response | null> {
  const result = await checkRateLimit(ip);
  if (result.ok) return null;
  return NextResponse.json(
    { error: "Too many requests. Please slow down and try again shortly." },
    { status: 429, headers: { "Retry-After": String(result.retryAfter) } },
  );
}
