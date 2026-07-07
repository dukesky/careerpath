import { NextResponse } from "next/server";
import { getIdentity } from "@/lib/identity";
import { getQuota } from "@/lib/quota";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const identity = getIdentity(request);
  try {
    const q = await getQuota(identity);
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
