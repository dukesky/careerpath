import { NextResponse } from "next/server";
import { getIdentity, hasBetaAccess } from "@/lib/identity";
import { getCaller, unauthorized } from "@/lib/api-auth";
import { getQuota } from "@/lib/quota";

export const runtime = "nodejs";

export async function GET(request: Request) {
  if (hasBetaAccess(request)) {
    return NextResponse.json({ remaining: null, unlimited: true });
  }
  const { ip } = getIdentity(request);
  const resolved = await getCaller(request);
  if (!resolved.ok) return unauthorized();
  try {
    const q = await getQuota(resolved.caller, ip);
    return NextResponse.json({
      remaining: q.remaining,
      used: q.used,
      limit: q.limit,
    });
  } catch {
    // If the store is unreachable, don't block the UI — report full quota.
    return NextResponse.json({ remaining: null });
  }
}
