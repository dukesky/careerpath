import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { resolveCaller, type CallerResult } from "./auth";

const MAX_RUN_ID_CHARS = 64;

/**
 * Resolve the Clerk session (if any) and turn the request into a Caller.
 * Clerk failures degrade to signed-out rather than failing the request.
 */
export async function getCaller(request: Request): Promise<CallerResult> {
  let userId: string | null = null;
  try {
    ({ userId } = await auth());
  } catch {
    console.warn(JSON.stringify({ evt: "clerk_auth_failed" }));
    userId = null;
  }
  return resolveCaller(request, userId);
}

/**
 * 401 for a present-but-invalid bearer token. The extension treats this as
 * "refresh the device token and retry once".
 */
export function unauthorized(): Response {
  return NextResponse.json(
    { error: "Your session token is invalid or expired." },
    { status: 401 },
  );
}

/**
 * Pull the client-generated runId out of a parsed body. It becomes part of a
 * Redis key, so the charset is restricted. Returns "" when absent — callers
 * treat that as "this request is its own run".
 */
export function readRunId(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const raw = (body as Record<string, unknown>).runId;
  if (typeof raw !== "string") return "";
  return raw
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, "")
    .slice(0, MAX_RUN_ID_CHARS);
}
