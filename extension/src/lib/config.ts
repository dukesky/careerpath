/**
 * The API origin. Vite inlines this at build time, so a dev build points at
 * localhost and a production build at the deployed app. Both origins are in
 * the manifest's host_permissions.
 */
export const API_BASE: string =
  import.meta.env.MODE === "production"
    ? "https://careerpath-hazel.vercel.app"
    : "http://localhost:3000";
