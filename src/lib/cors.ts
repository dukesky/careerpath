/**
 * CORS for the Chrome extension. The allowlist is an env var of extension IDs
 * rather than a wildcard, so a random extension cannot spend a user's quota.
 */

const PREFIX = "chrome-extension://";

function allowedIds(): string[] {
  return (process.env.ALLOWED_EXTENSION_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isAllowedOrigin(origin: string | null): boolean {
  if (!origin || !origin.startsWith(PREFIX)) return false;
  const id = origin.slice(PREFIX.length);
  if (!id || id.includes("/")) return false;
  return allowedIds().includes(id);
}

export function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers":
      "content-type, authorization, x-anon-id, x-access-code",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export function preflightResponse(origin: string): Response {
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}
