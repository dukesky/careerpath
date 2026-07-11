export const ANON_HEADER = "x-anon-id";
export const ACCESS_HEADER = "x-access-code";

export interface Identity {
  anonId: string;
  ip: string;
}

/**
 * Beta bypass: an `x-access-code` header matching one of the comma-separated
 * codes in the server-only `BETA_ACCESS_CODES` env var grants unlimited
 * tailors (skips the business quota — NOT the per-IP rate limit). Rotate the
 * env var to revoke all codes.
 */
export function hasBetaAccess(request: Request): boolean {
  const code = (request.headers.get(ACCESS_HEADER) ?? "").trim();
  if (!code) return false;
  const allowed = (process.env.BETA_ACCESS_CODES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return allowed.length > 0 && allowed.includes(code);
}

/** Extract the anonymous id (header) and client IP from a request. */
export function getIdentity(request: Request): Identity {
  const anonId = (request.headers.get(ANON_HEADER) ?? "").trim().slice(0, 100);

  const forwarded = request.headers.get("x-forwarded-for");
  const ip =
    (forwarded ? forwarded.split(",")[0] : request.headers.get("x-real-ip")) ??
    "";

  return { anonId, ip: ip.trim() || "unknown" };
}
