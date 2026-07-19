import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { listSaved, saveResume } from "@/lib/saved";
import { normalizeResume } from "@/lib/resume";

export const runtime = "nodejs";

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const items = await listSaved(userId);
  return NextResponse.json({ items });
}

export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  let body: {
    company?: unknown;
    roleTitle?: unknown;
    resume?: unknown;
    jdSummary?: unknown;
    jdUrl?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  if (!body.resume) {
    return NextResponse.json({ error: "Missing resume." }, { status: 400 });
  }

  const jdUrl =
    typeof body.jdUrl === "string" && /^https?:\/\//i.test(body.jdUrl.trim())
      ? body.jdUrl.trim().slice(0, 2000)
      : undefined;

  const saved = await saveResume(userId, {
    company: typeof body.company === "string" ? body.company : "",
    roleTitle: typeof body.roleTitle === "string" ? body.roleTitle : "",
    resume: normalizeResume(body.resume),
    jdSummary:
      typeof body.jdSummary === "string" ? body.jdSummary.slice(0, 500) : "",
    jdUrl,
  });
  return NextResponse.json({ saved });
}
