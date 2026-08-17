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
