import { NextResponse } from "next/server";
import { issueDeviceToken } from "@/lib/auth";
import { getIdentity } from "@/lib/identity";
import { rateLimitResponse } from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * Mint a device identity for the extension. Called once on install and again
 * whenever the stored token nears expiry. Rate-limited per IP so it cannot be
 * used to farm fresh trial quotas.
 */
export async function POST(request: Request) {
  const { ip } = getIdentity(request);
  const limited = await rateLimitResponse(ip);
  if (limited) return limited;

  try {
    const { token } = await issueDeviceToken();
    return NextResponse.json({ token });
  } catch {
    return NextResponse.json(
      { error: "Device tokens are not configured." },
      { status: 503 },
    );
  }
}
