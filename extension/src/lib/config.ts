/**
 * The API origin. Vite inlines this at build time, so a dev build points at
 * localhost and a production build at the deployed app. Both origins are in
 * the manifest's host_permissions.
 *
 * This is the APEX domain, not www. Keep it that way unless Vercel is
 * configured with www as primary: an apex->www redirect on a POST is a
 * redirect the API client would have to follow, and a 301/302 would drop the
 * method and body. Whichever host Vercel serves directly is the one that
 * belongs here.
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
 * TEMPORARY: there is no production Clerk instance yet, so both build modes
 * currently resolve to the same development instance. This branches on mode
 * anyway (like API_BASE) so that provisioning production later is a
 * one-branch edit, not a restructuring. See CLERK_FRONTEND_API below for why
 * this has to be fixed before the extension is first submitted to the Web
 * Store — it is not just a placeholder-of-convenience.
 */
export const CLERK_PUBLISHABLE_KEY: string =
  import.meta.env.MODE === "production"
    ? "pk_test_ZmFpci1sZW11ci0zNC5jbGVyay5hY2NvdW50cy5kZXYk"
    : "pk_test_ZmFpci1sZW11ci0zNC5jbGVyay5hY2NvdW50cy5kZXYk";

/**
 * Clerk's Frontend API host, which MUST also appear in host_permissions or
 * the extension cannot reach Clerk at all (see API_HOSTS in
 * manifest.config.ts, which must not drift from this value — see the test
 * that pins them together).
 *
 * TEMPORARY, same as CLERK_PUBLISHABLE_KEY above: both build modes point at
 * the development instance (fair-lemur-34.clerk.accounts.dev) because
 * production has no Clerk instance of its own yet. This is a real deadline,
 * not a nice-to-have: a production instance lives on a different Frontend
 * API domain, which means a different host_permissions entry, and adding a
 * host permission AFTER the extension is published to the Chrome Web Store
 * disables it for every existing user until they re-approve it. The
 * production branch below MUST point at a real production Clerk instance
 * BEFORE the first Web Store submission — not fixed after the fact.
 */
export const CLERK_FRONTEND_API: string =
  import.meta.env.MODE === "production"
    ? "https://fair-lemur-34.clerk.accounts.dev"
    : "https://fair-lemur-34.clerk.accounts.dev";
