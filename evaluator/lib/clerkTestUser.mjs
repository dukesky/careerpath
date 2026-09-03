import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * The evaluator's account on the Clerk DEVELOPMENT instance.
 *
 * A "+clerk_test" local part puts the address in Clerk's test mode: the email
 * code is always 424242 and no mail is ever sent. NOTHING here touches a real
 * account, a real inbox, a password, or Google OAuth — the harness must never
 * be able to sign in as a real person even by accident.
 */
export const TEST_EMAIL = "evaluator+clerk_test@example.com";

/** Clerk's fixed verification code for +clerk_test addresses in test mode. */
export const TEST_CODE = "424242";

/**
 * Reads CLERK_SECRET_KEY out of the repo's .env.local. It is already there
 * for `npm run dev`; the harness does not introduce a new secret.
 */
export async function readClerkSecret(repoRoot) {
  const text = await readFile(path.join(repoRoot, ".env.local"), "utf8");
  for (const line of text.split("\n")) {
    const match = /^\s*CLERK_SECRET_KEY\s*=\s*(.+?)\s*$/.exec(line);
    if (match) return match[1].replace(/^["']|["']$/g, "");
  }
  return null;
}

/**
 * Make sure the test account exists, WITHOUT automating a sign-up form.
 *
 * The dev instance requires a password at sign-up and has bot protection on,
 * so driving the sign-up UI would mean typing a password and fighting a
 * captcha — both explicitly out of bounds. The Backend API creates the
 * account on the same dev instance with no password at all, which leaves
 * email-code as the only first factor: exactly the flow the harness drives.
 */
export async function ensureTestUser(secretKey, log) {
  const headers = {
    authorization: `Bearer ${secretKey}`,
    "content-type": "application/json",
  };
  const listUrl = `https://api.clerk.com/v1/users?email_address=${encodeURIComponent(TEST_EMAIL)}`;
  const existing = await fetch(listUrl, { headers });
  if (existing.ok) {
    const users = await existing.json();
    if (Array.isArray(users) && users.length > 0) {
      log(`clerk test user already exists: ${users[0].id}`);
      return { ok: true, userId: users[0].id, created: false };
    }
  } else {
    return { ok: false, error: `list users -> ${existing.status} ${await existing.text()}` };
  }

  const created = await fetch("https://api.clerk.com/v1/users", {
    method: "POST",
    headers,
    body: JSON.stringify({
      email_address: [TEST_EMAIL],
      skip_password_requirement: true,
    }),
  });
  if (!created.ok) {
    return { ok: false, error: `create user -> ${created.status} ${await created.text()}` };
  }
  const user = await created.json();
  log(`clerk test user created: ${user.id}`);
  return { ok: true, userId: user.id, created: true };
}
