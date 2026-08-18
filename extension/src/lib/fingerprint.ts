import type { ParsedResume } from "@shared/contract";

/**
 * Identifies which resume produced a cached run.
 *
 * The result cache is keyed on the posting alone, so without this a user who
 * replaces their resume keeps seeing analyses and rewrites computed from the
 * old one, with nothing on screen saying so. Every cache entry carries this,
 * and an entry whose fingerprint does not match the resume loaded now is
 * treated as absent.
 *
 * FNV-1a over the serialized resume: synchronous, dependency-free, and
 * adequate here. This needs neither collision resistance nor secrecy — a
 * collision would surface one stale entry, which is exactly today's behaviour,
 * at a probability irrelevant across the 20 entries the cache holds. Do not
 * "upgrade" it to crypto.subtle: that is async, and it would make every cache
 * read await a digest for no benefit.
 */
export function resumeFingerprint(resume: ParsedResume): string {
  const json = JSON.stringify(resume);
  let hash = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    hash ^= json.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
