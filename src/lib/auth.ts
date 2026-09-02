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

/**
 * Short by design. A run token lets the extension's service worker transact
 * as a user, and unlike the Clerk session it was minted from, nothing in the
 * worker can re-mint it — so it has to outlive one generation (about a
 * minute, three API calls) with room for a retry, and not much more. Fifteen
 * minutes bounds a leaked token's damage to that user's remaining daily
 * allowance; it grants nothing else.
 */
const RUN_TOKEN_TTL = "15m";

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

/** Mint the token the panel hands its service worker so runs bill to this user. */
export async function issueRunToken(userId: string): Promise<string> {
  return new SignJWT({ uid: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(RUN_TOKEN_TTL)
    .sign(secret());
}

/**
 * What an `Authorization: Bearer` actually is, or null if it is not ours.
 *
 * Both token kinds are signed with the SAME secret and algorithm, so the
 * signature check cannot separate them — the CLAIM does: `uid` for a run
 * token, `did` for a device token. One verify, then discriminate. Two
 * separate verify functions would each accept the other's token at the
 * signature step and rely on a claim check anyway, so this keeps the one
 * decision in one place.
 *
 * `uid` is checked FIRST. A token carrying both claims is not something this
 * server ever mints, and treating such a thing as the weaker identity is the
 * safe direction to be wrong in.
 */
export type BearerIdentity =
  | { kind: "user"; userId: string }
  | { kind: "device"; deviceId: string };

export async function verifyBearer(token: string): Promise<BearerIdentity | null> {
  if (!token) return null;
  try {
    // Pin the algorithm. A Uint8Array key already restricts jose to the HS
    // family, but stating it makes the intent explicit rather than an
    // emergent property of the key type.
    const { payload } = await jwtVerify(token, secret(), { algorithms: ["HS256"] });
    const uid = payload.uid;
    if (typeof uid === "string" && uid.length > 0) return { kind: "user", userId: uid };
    const did = payload.did;
    if (typeof did === "string" && did.length > 0) return { kind: "device", deviceId: did };
    return null;
  } catch {
    return null;
  }
}

/** Returns the device id, or null for anything that is not a valid device token. */
export async function verifyDeviceToken(token: string): Promise<string | null> {
  const identity = await verifyBearer(token);
  return identity?.kind === "device" ? identity.deviceId : null;
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
    const identity = await verifyBearer(token);
    if (!identity) return { ok: false, reason: "invalid_token" };
    // A run token IS the user, minted for the extension's service worker
    // because the worker has no Clerk session of its own to present.
    return identity.kind === "user"
      ? { ok: true, caller: { kind: "user", userId: identity.userId } }
      : { ok: true, caller: { kind: "device", deviceId: identity.deviceId } };
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
