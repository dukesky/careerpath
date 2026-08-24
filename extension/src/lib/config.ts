/**
 * The API origin. Vite inlines this at build time, so a dev build points at
 * localhost and a production build at the deployed app. Both origins are in
 * the manifest's host_permissions.
 *
 * This is the APEX, which is the canonical host for this project by decision.
 *
 * READ THIS BEFORE CHANGING IT. The rule is: whichever host Vercel serves
 * DIRECTLY belongs here. A 308 preserves method and body, so pointing at the
 * redirecting host still works — it just pays an extra round trip on every
 * single API call, silently.
 *
 * As of 2026-08-23 Vercel still served www directly and 308-redirected the
 * apex to it, so at the moment this was written the apex was the redirecting
 * host and every call paid that hop. That is a deliberate, temporary cost:
 * the apex is the intended primary, and the Vercel domain config is meant to
 * be flipped to match. Verify with `curl -si -X POST
 * https://career-allpath.com/api/device-token` — a 2xx/4xx means the flip
 * happened and this is now the direct host; a 308 means it has not, and the
 * hop is still being paid.
 *
 * Both hosts are in the manifest's host_permissions, so neither value breaks
 * the extension.
 */
export const API_BASE: string =
  import.meta.env.MODE === "production"
    ? "https://career-allpath.com"
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
