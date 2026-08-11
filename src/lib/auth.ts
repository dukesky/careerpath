import { SignJWT, jwtVerify } from "jose";

/**
 * Caller identity for quota purposes.
 *
 * - "user"   — signed in via Clerk (web or extension)
 * - "device" — extension, signed out; the device id is SERVER-issued and
 *              carried in a signed JWT, because extension code is public and
 *              a client-generated id (see anon.ts) resets by editing a string
 * - "anon"   — legacy web path, still keyed on the x-anon-id header
 */
export type Caller =
  | { kind: "user"; userId: string }
  | { kind: "device"; deviceId: string }
  | { kind: "anon"; anonId: string };

/**
 * No Authorization header is normal (the web app). A bearer token that fails
 * verification is NOT — it is an extension whose token expired, and it needs a
 * 401 so it knows to refresh rather than silently spending anon quota.
 */
export type CallerResult =
  | { ok: true; caller: Caller }
  | { ok: false; reason: "invalid_token" };

const DEVICE_TOKEN_TTL = "24h";
const MAX_ANON_ID_CHARS = 100;

function secret(): Uint8Array {
  const value = process.env.DEVICE_TOKEN_SECRET;
  if (!value) {
    throw new Error(
      "DEVICE_TOKEN_SECRET is not set. Add it to .env.local (see .env.example).",
    );
  }
  return new TextEncoder().encode(value);
}

/** Mint a fresh device identity plus the signed token that carries it. */
export async function issueDeviceToken(): Promise<{
  token: string;
  deviceId: string;
}> {
  const deviceId = crypto.randomUUID();
  const token = await new SignJWT({ did: deviceId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(DEVICE_TOKEN_TTL)
    .sign(secret());
  return { token, deviceId };
}

/** Returns the device id, or null for any invalid/expired/forged token. */
export async function verifyDeviceToken(token: string): Promise<string | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    const did = payload.did;
    return typeof did === "string" && did.length > 0 ? did : null;
  } catch {
    return null;
  }
}

function bearer(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  return header.toLowerCase().startsWith("bearer ")
    ? header.slice(7).trim()
    : "";
}

/**
 * Resolve a request into a Caller. `clerkUserId` is passed in (rather than
 * read here) so this stays a pure, testable function; routes obtain it with
 * `const { userId } = await auth()`.
 *
 * Precedence: signed-in user > valid device token > legacy anon header.
 * A bearer token that is present but fails verification short-circuits to a
 * rejection — see the CallerResult doc comment.
 */
export async function resolveCaller(
  request: Request,
  clerkUserId: string | null,
): Promise<CallerResult> {
  if (clerkUserId) {
    return { ok: true, caller: { kind: "user", userId: clerkUserId } };
  }

  const token = bearer(request);
  if (token) {
    const deviceId = await verifyDeviceToken(token);
    if (!deviceId) return { ok: false, reason: "invalid_token" };
    return { ok: true, caller: { kind: "device", deviceId } };
  }

  const anonId = (request.headers.get("x-anon-id") ?? "")
    .trim()
    .slice(0, MAX_ANON_ID_CHARS);
  return { ok: true, caller: { kind: "anon", anonId } };
}

/** Stable namespace for quota keys. */
export function callerKey(caller: Caller): string {
  switch (caller.kind) {
    case "user":
      return `user:${caller.userId}`;
    case "device":
      return `device:${caller.deviceId}`;
    case "anon":
      return `anon:${caller.anonId || "none"}`;
  }
}
