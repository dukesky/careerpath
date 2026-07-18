import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { deleteSaved } from "@/lib/saved";

export const runtime = "nodejs";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const { id } = await params;
  await deleteSaved(userId, id);
  return NextResponse.json({ ok: true });
}
