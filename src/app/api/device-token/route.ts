import { NextResponse } from "next/server";
import { issueDeviceToken } from "@/lib/auth";
import { getIdentity } from "@/lib/identity";
import { DEVICE_TOKEN_RATE_LIMIT, rateLimitResponse } from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * Mint a device identity for the extension. Called once on install and again
 * whenever the stored token nears expiry.
 *
 * Minting draws on its OWN tight per-IP bucket rather than the shared request
 * budget, for two reasons. It keeps token refresh from competing with real
 * work — a user mid-session must never be refused a refresh because they were
 * busy tailoring — and it stops one IP from minting identities at the shared
 * bucket's rate. Note what this does and does not buy: a fresh device id
 * carries a fresh trial allowance, but `quota:ip:<ip>:<day>` still caps what
 * any one IP can actually spend, so minting alone never yields unlimited runs.
 * The device token's real job is to make quota reset cost more than editing a
 * string in local storage.
 */
export async function POST(request: Request) {
  const { ip } = getIdentity(request);
  const limited = await rateLimitResponse(ip, DEVICE_TOKEN_RATE_LIMIT);
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
