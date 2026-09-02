import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { issueRunToken } from "@/lib/auth";
import { getIdentity } from "@/lib/identity";
import { DEVICE_TOKEN_RATE_LIMIT, rateLimitResponse } from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * Exchange a Clerk session for a short-lived token the extension's service
 * worker can run under.
 *
 * Why this exists: the worker is a separate JS realm with no Clerk session of
 * its own, and it cannot be given one — the SDK's storage-backed client can
 * only be seeded from a cookie the panel's client never writes. So the panel,
 * which does have a working Clerk identity, trades it here for something it
 * can pass over chrome.runtime messaging. Without this, every background run
 * transacted as an anonymous device and no user's quota was ever charged.
 *
 * Minting draws on the SAME tight per-IP bucket as device tokens rather than
 * the shared request budget: token acquisition must never compete with real
 * work, and a user mid-session must not be refused a run because they were
 * busy tailoring.
 */
export async function POST(request: Request) {
  const { ip } = getIdentity(request);
  const limited = await rateLimitResponse(ip, DEVICE_TOKEN_RATE_LIMIT);
  if (limited) return limited;

  const { userId } = await auth();
  // No session, no identity to mint. Deliberately NOT a fallback to some
  // weaker caller: this endpoint exists only to answer "who is signed in",
  // and an unauthenticated 200 here would hand an account's quota to anyone.
  if (!userId) {
    return NextResponse.json(
      { error: "Sign in to continue." },
      { status: 401 },
    );
  }

  try {
    return NextResponse.json({ token: await issueRunToken(userId) });
  } catch {
    return NextResponse.json(
      { error: "Run tokens are not configured." },
      { status: 503 },
    );
  }
}
