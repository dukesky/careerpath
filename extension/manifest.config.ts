import { defineManifest } from "@crxjs/vite-plugin";

// API origins the panel and worker fetch. Listing them as host_permissions
// lets extension pages make these requests directly; the server's CORS
// allowlist is the second layer, not the only one.
// The Vercel origin stays alongside the custom domain deliberately. Adding a
// host permission AFTER publishing disables the extension for every existing
// user until they re-approve it; removing one costs nothing. So while DNS and
// the Vercel domain binding settle, carry both and drop the vercel.app entry
// later, rather than shipping a single origin that might not resolve yet.
// Both apex and www are listed because a match pattern is exact about the
// host, and Vercel serves one as a redirect to the other.
const API_HOSTS = [
  "http://localhost:3000/*",
  "https://career-allpath.com/*",
  "https://www.career-allpath.com/*",
  "https://careerpath-hazel.vercel.app/*",
  // Clerk's Frontend API host. Declared literally, NOT imported, because this
  // file is loaded directly by Vite's Node bootstrap (via vite.config.ts)
  // before import.meta.env is available to it — see src/lib/config.ts's
  // CLERK_FRONTEND_API for the same value with the runtime-facing comment.
  // MUST match CLERK_FRONTEND_API's origin exactly, or Clerk requests fail
  // at runtime while every test that doesn't check this one stays green;
  // src/__tests__/manifest.test.ts pins the two together so a change to
  // either file with the other left behind fails the suite.
  "https://fair-lemur-34.clerk.accounts.dev/*",
];

// The five job sites the product targets. Granted at install, so the panel
// reads them with no click and no per-tab grant — which activeTab alone
// cannot provide for a window-global side panel that follows tab switches.
// The install prompt names these five domains rather than "all websites".
//
// Note what this does NOT cover: a company that white-labels Workday on its
// own domain (careers.example.com) does not match *.myworkdayjobs.com. Those
// fall to the optional grant below, same as any other site.
const JOB_SITES = [
  "*://*.linkedin.com/*",
  "*://*.greenhouse.io/*",
  "*://*.lever.co/*",
  "*://*.ashbyhq.com/*",
  "*://*.myworkdayjobs.com/*",
];

// Everything else. Optional permissions do NOT appear in the install prompt;
// the panel requests these from a click handler when the user asks to read a
// site we do not already cover. Declaring them here is a precondition —
// chrome.permissions.request rejects origins that are not declared.
const OPTIONAL_HOSTS = ["http://*/*", "https://*/*"];

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
  // "cookies" is Clerk's: its SDK reads/writes session cookies on its own
  // Frontend API domain to keep the extension signed in. This widens the
  // install prompt, same as the Clerk host_permissions entry above — an
  // accepted, deliberate cost of adding sign-in.
  permissions: ["storage", "sidePanel", "activeTab", "scripting", "cookies"],
  host_permissions: [...API_HOSTS, ...JOB_SITES],
  optional_host_permissions: OPTIONAL_HOSTS,
  content_security_policy: {
    // The PDF layout engine (@react-pdf/layout -> yoga-layout) is compiled to
    // WebAssembly. MV3's default extension_pages CSP is `script-src 'self'`,
    // which blocks WASM compilation outright: without 'wasm-unsafe-eval' the
    // Download PDF button throws a CSP CompileError on every click and the
    // panel can only report a generic failure. This is NOT a permission and
    // does not appear in the install prompt.
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
  },
  background: {
    service_worker: "src/background/index.ts",
    type: "module",
  },
  side_panel: {
    default_path: "src/sidepanel/index.html",
  },
  // The sign-in page is reached via chrome.runtime.getURL, not a manifest
  // field CRXJS already knows to expose (side_panel, background, content
  // scripts). NOT empirically confirmed — see task-4-report.md: this
  // environment could not get Chrome to load ANY unpacked extension
  // (verified with a trivial one-line manifest too), so direct-navigation
  // behavior with vs. without this entry was never actually observed.
  // Included on the brief's explicit recommendation and because it is
  // low-risk (the content script's own resource is already exposed the same
  // way, below) — remove it if a real browser test shows it unnecessary.
  web_accessible_resources: [
    {
      resources: ["src/signin/index.html"],
      matches: ["<all_urls>"],
    },
  ],
  icons: {
    "16": "icons/icon-16.png",
    "32": "icons/icon-32.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png",
  },
  action: {
    default_title: "Tailor my resume",
    default_icon: {
      "16": "icons/icon-16.png",
      "32": "icons/icon-32.png",
    },
  },
});
