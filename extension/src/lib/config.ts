/**
 * The API origin. Vite inlines this at build time, so a dev build points at
 * localhost and a production build at the deployed app. Both origins are in
 * the manifest's host_permissions.
 *
 * This is www, not the apex, because www is the host Vercel serves directly:
 * the apex 308-redirects to it (verified 2026-08-23 — `curl -si -X POST
 * https://career-allpath.com/api/device-token` answers 308). A 308 does
 * preserve method and body, so apex would still work, but every call would
 * pay a redirect hop for nothing. If the Vercel domain config ever flips
 * which host is primary, flip this with it — whichever host answers 2xx
 * directly is the one that belongs here.
 */
export const API_BASE: string =
  import.meta.env.MODE === "production"
    ? "https://www.career-allpath.com"
    : "http://localhost:3000";

/**
 * Clerk's publishable key is public by design — it identifies the instance to
 * Clerk's frontend API and grants nothing on its own. It is compiled in, like
 * API_BASE, because an extension has no server-side config to read.
 *
 * The production key is the one the deployed app serves (the same
 * NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY Vercel injects); it base64-decodes to
 * the production Frontend API host, which is how the test in
 * src/lib/__tests__/config.test.ts pins it to CLERK_FRONTEND_API below. The
 * development key points at the Clerk development instance used by
 * `npm run dev` on the website.
 */
export const CLERK_PUBLISHABLE_KEY: string =
  import.meta.env.MODE === "production"
    ? "pk_live_Y2xlcmsuY2FyZWVyLWFsbHBhdGguY29tJA"
    : "pk_test_ZmFpci1sZW11ci0zNC5jbGVyay5hY2NvdW50cy5kZXYk";

/**
 * Clerk's Frontend API host, which MUST also appear in host_permissions or
 * the extension cannot reach Clerk at all (see API_HOSTS in
 * manifest.config.ts, which must not drift from this value — see the test
 * that pins them together).
 *
 * Production is the Clerk production instance on the product's own domain
 * (a CNAME to Clerk, set up through the Vercel Marketplace integration);
 * development is the Clerk-hosted development instance. Both hosts are in
 * the manifest's host_permissions — adding a host permission AFTER the
 * extension is published to the Chrome Web Store disables it for every
 * existing user until they re-approve it, so the production host must be
 * there before the first Web Store submission, not added after.
 */
export const CLERK_FRONTEND_API: string =
  import.meta.env.MODE === "production"
    ? "https://clerk.career-allpath.com"
    : "https://fair-lemur-34.clerk.accounts.dev";
