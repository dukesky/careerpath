export const ANON_HEADER = "x-anon-id";

export interface Identity {
  anonId: string;
  ip: string;
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
