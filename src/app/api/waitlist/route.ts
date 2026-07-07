import { NextResponse } from "next/server";
import { getIdentity } from "@/lib/identity";
import { getKV } from "@/lib/kv";

export const runtime = "nodejs";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WAITLIST_KEY = "waitlist";

export async function POST(request: Request) {
  let email = "";
  try {
    const body = (await request.json()) as { email?: unknown };
    email = typeof body.email === "string" ? body.email.trim() : "";
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!EMAIL_RE.test(email) || email.length > 200) {
    return NextResponse.json(
      { error: "Please enter a valid email address." },
      { status: 400 },
    );
  }

  const { anonId } = getIdentity(request);
  const entry = JSON.stringify({
    email,
    anonId,
    at: new Date().toISOString(),
  });

  try {
    await getKV().rpush(WAITLIST_KEY, entry);
  } catch {
    // Best effort — never fail the user's signup on a storage hiccup.
  }

  return NextResponse.json({ ok: true });
}
