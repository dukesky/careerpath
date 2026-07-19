import { getKV } from "./kv";
import type { ParsedResume } from "./resume";

/**
 * Opt-in saved resume versions, keyed per authenticated user in a Redis hash
 * (`saved:<userId>`), field = version id. Only written when a signed-in user
 * explicitly clicks "Save this version" — anonymous use stores nothing.
 */

export interface SavedResume {
  id: string;
  company: string;
  roleTitle: string;
  savedAt: string; // ISO 8601
  resume: ParsedResume;
  jdSummary: string;
  jdUrl?: string; // set only when the JD was ingested from a link
}

const MAX_PER_USER = 50;
const userKey = (userId: string) => `saved:${userId}`;

export async function listSaved(userId: string): Promise<SavedResume[]> {
  const all = await getKV().hgetall(userKey(userId));
  const items: SavedResume[] = [];
  for (const raw of Object.values(all)) {
    try {
      items.push(JSON.parse(raw) as SavedResume);
    } catch {
      // skip a corrupt record
    }
  }
  // Newest first.
  items.sort((a, b) => (a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : 0));
  return items;
}

export async function saveResume(
  userId: string,
  input: {
    company: string;
    roleTitle: string;
    resume: ParsedResume;
    jdSummary: string;
    jdUrl?: string;
  },
): Promise<SavedResume> {
  const kv = getKV();
  const record: SavedResume = {
    id: crypto.randomUUID(),
    savedAt: new Date().toISOString(),
    company: input.company,
    roleTitle: input.roleTitle,
    resume: input.resume,
    jdSummary: input.jdSummary,
    ...(input.jdUrl ? { jdUrl: input.jdUrl } : {}),
  };
  await kv.hset(userKey(userId), record.id, JSON.stringify(record));

  // Enforce a per-user cap — drop the oldest beyond the limit.
  const all = await listSaved(userId);
  if (all.length > MAX_PER_USER) {
    for (const old of all.slice(MAX_PER_USER)) {
      await kv.hdel(userKey(userId), old.id);
    }
  }
  return record;
}

export async function deleteSaved(userId: string, id: string): Promise<void> {
  await getKV().hdel(userKey(userId), id);
}
