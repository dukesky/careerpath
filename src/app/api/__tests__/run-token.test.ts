import { describe, it, expect, beforeEach, vi } from "vitest";

// Must be hoisted above the route import.
vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(async () => ({ userId: null })),
}));

import { auth } from "@clerk/nextjs/server";
import { resetKV } from "@/lib/kv";
import { verifyBearer } from "@/lib/auth";
import { POST } from "@/app/api/run-token/route";

const IP = "6.6.6.6";

const post = () =>
  new Request("https://example.com/api/run-token", {
    method: "POST",
    headers: { "x-forwarded-for": IP },
  });

beforeEach(() => {
  resetKV();
  vi.mocked(auth).mockResolvedValue({ userId: null } as never);
  process.env.DEVICE_TOKEN_SECRET = "test-secret-value-at-least-32-chars-long";
});

describe("POST /api/run-token", () => {
  // The whole point of the endpoint: with no Clerk session there is no user to
  // mint for, and any answer but 401 would hand an account's quota to an
  // unauthenticated caller.
  it("refuses a caller with no Clerk session", async () => {
    const res = await POST(post());
    expect(res.status).toBe(401);
  });

  it("mints a token that resolves back to the signed-in user", async () => {
    vi.mocked(auth).mockResolvedValue({ userId: "user_abc123" } as never);

    const res = await POST(post());
    expect(res.status).toBe(200);

    const body = (await res.json()) as { token?: string };
    expect(typeof body.token).toBe("string");

    // Checked through the real verifier rather than by decoding the JWT: the
    // property that matters is that the API routes will accept this token as
    // this user, not that it has a particular shape.
    expect(await verifyBearer(body.token!)).toEqual({
      kind: "user",
      userId: "user_abc123",
    });
  });
});
