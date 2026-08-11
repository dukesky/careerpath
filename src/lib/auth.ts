import { SignJWT, jwtVerify } from "jose";
// The anon header name and its length cap have exactly one definition, in
// identity.ts. Two copies of the rule that derives a live user's quota key
// would silently split their quota bucket the day the copies drift.
import { ANON_HEADER, MAX_ANON_ID_CHARS } from "./identity";

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

const MIN_SECRET_CHARS = 32;

function secret(): Uint8Array {
  const value = process.env.DEVICE_TOKEN_SECRET;
  if (!value) {
    throw new Error(
      "DEVICE_TOKEN_SECRET is not set. Add it to .env.local (see .env.example).",
    );
  }
  if (value.length < MIN_SECRET_CHARS) {
    throw new Error(
      `DEVICE_TOKEN_SECRET must be at least ${MIN_SECRET_CHARS} characters. Generate one with: openssl rand -base64 32`,
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
    // Pin the algorithm. A Uint8Array key already restricts jose to the HS
    // family, but stating it makes the intent explicit rather than an
    // emergent property of the key type.
    const { payload } = await jwtVerify(token, secret(), {
      algorithms: ["HS256"],
    });
    const did = payload.did;
    return typeof did === "string" && did.length > 0 ? did : null;
  } catch {
    return null;
  }
}

/**
 * Three distinct outcomes, and the difference matters:
 *   null — no Authorization header at all (the web app) → fall through to anon
 *   ""   — header present but unusable (wrong scheme, empty token) → reject
 *   else — the token to verify
 *
 * Note the case handling: the scheme test lowercases, but the token is sliced
 * from the original string. Lowercasing the token would corrupt base64url and
 * turn every valid extension request into an invalid one.
 */
function bearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header === null) return null;
  const trimmed = header.trim();
  if (!trimmed.toLowerCase().startsWith("bearer ")) return "";
  return trimmed.slice(7).trim();
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
  if (token !== null) {
    // An Authorization header was sent. It is either good or it is a 401 —
    // never a silent downgrade to anon, or the extension can't learn its
    // token died.
    if (!token) return { ok: false, reason: "invalid_token" };
    const deviceId = await verifyDeviceToken(token);
    if (!deviceId) return { ok: false, reason: "invalid_token" };
    return { ok: true, caller: { kind: "device", deviceId } };
  }

  const anonId = (request.headers.get(ANON_HEADER) ?? "")
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
