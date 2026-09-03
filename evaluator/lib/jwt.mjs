/** Decode a JWT payload without verifying it. Evidence only — never trust. */
export function decodeJwtPayload(token) {
  const parts = String(token).split(".");
  if (parts.length < 2) return null;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
      "utf8",
    );
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}
