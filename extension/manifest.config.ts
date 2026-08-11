import { defineManifest } from "@crxjs/vite-plugin";

// API origins the panel and worker fetch. Listing them as host_permissions
// lets extension pages make these requests directly; the server's CORS
// allowlist is the second layer, not the only one.
const API_HOSTS = [
  "http://localhost:3000/*",
  "https://careerpath-hazel.vercel.app/*",
];

export default defineManifest({
  manifest_version: 3,
  name: "career-path — tailor your resume",
  version: "0.1.0",
  description:
    "Tailor your resume to the job posting you're looking at — honestly, without inventing experience.",
  // Pins the extension ID across reloads. The server's CORS allowlist keys on
  // that ID, so an ID that drifts looks like CORS spontaneously breaking.
  // Public key only — extension/key.pem is gitignored.
  key: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0Vc+YGvX/ss6iiR+VEOn8RfC3uKWCtIiQweZcyavaUPjX02cbOUH2JvUR7127aeih6Br08+nfARjmm+CmezOBZPq02VFgDkPpVeCtvJWWBZ8BLZ2MZTMapwcoR09QRCwkb2mdRSf5G0LmYQS8M+ArS2OHH+I5l9TFRvoCnxTHCGbTqPSFdBr9pnilbMeGl9WYwV7Gm78HVocgPEtdXvRTNsq2GCE3TpPu7vlDKCWEDakOSuK/kVFb9GYLHLjFp6juqcxbQKDHduW7KMOo5teoAuokGikcZiPT9zbfvD9SO1LLuX8PtH2e58J/Ltmt8XUG6FEzajrFGcJMyIHwVVkGwIDAQAB",
  minimum_chrome_version: "114",
  permissions: ["storage", "sidePanel", "activeTab", "scripting"],
  host_permissions: API_HOSTS,
  background: {
    service_worker: "src/background/index.ts",
    type: "module",
  },
  side_panel: {
    default_path: "src/sidepanel/index.html",
  },
  action: {
    default_title: "Tailor my resume",
  },
});
