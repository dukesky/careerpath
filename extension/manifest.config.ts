import { defineManifest } from "@crxjs/vite-plugin";

// API origins the panel and worker fetch, per build mode. Listing them as
// host_permissions lets extension pages make these requests directly; the
// server's CORS allowlist is the second layer, not the only one.
//
// Production carries ONLY what the shipped extension talks to. Every entry
// here is a line in the Web Store install prompt and a question from the
// reviewer, and — the asymmetry this whole file keeps repeating — adding a
// host permission AFTER publishing disables the extension for every
// existing user until they re-approve it, while removing one costs nothing.
// So the production list is decided before the first submission and only
// ever shrinks. The former careerpath-hazel.vercel.app entry is gone: the
// custom domain is bound and serving, so nothing fetches from it anymore.
//
// Both apex and www are listed because a match pattern is exact about the
// host, and Vercel serves one as a redirect to the other.
//
// The Clerk Frontend API host is declared literally, NOT imported, because
// this file is loaded directly by Vite's Node bootstrap (via vite.config.ts)
// before import.meta.env is available to it — see src/lib/config.ts's
// CLERK_FRONTEND_API for the same values with the runtime-facing comment.
// It MUST match CLERK_FRONTEND_API's origin for the same mode exactly, or
// Clerk requests fail at runtime while every test that doesn't check this
// one stays green; src/__tests__/manifest.test.ts pins the two files
// together, per mode, so a change to either with the other left behind
// fails the suite.
const PRODUCTION_API_HOSTS = [
  "https://career-allpath.com/*",
  "https://www.career-allpath.com/*",
  "https://clerk.career-allpath.com/*",
];

// Development adds the local Next.js server and the Clerk development
// instance. These never ship: `vite build` (mode "production") excludes
// them; only `npm run build:dev` (mode "development") includes them.
const DEVELOPMENT_API_HOSTS = [
  "http://localhost:3000/*",
  ...PRODUCTION_API_HOSTS,
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

export default defineManifest((env) => ({
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
  // Deliberately NO "cookies" here, despite Clerk. Its SDK only touches
  // chrome.cookies for the Sync Host feature (signing in on the website and
  // carrying that into the extension), which this build does not use and
  // cannot: Sync Host does not work for side panels — see the CHANGELOG's
  // Known limits. Verified in the installed package rather than assumed:
  // @clerk/chrome-extension's validateManifest requires permissions.cookies
  // only under `if (features.sync)`, and `sync` is `Boolean(syncHost)` —
  // src/lib/clerk.ts passes no syncHost, so the check never runs and the
  // cookies code path is never reached. Adding it anyway would widen the
  // Web Store install prompt and hand the extension chrome.cookies access
  // across every host it has permission for, for nothing.
  permissions: ["storage", "sidePanel", "activeTab", "scripting"],
  host_permissions: [
    ...(env.mode === "production"
      ? PRODUCTION_API_HOSTS
      : DEVELOPMENT_API_HOSTS),
    ...JOB_SITES,
  ],
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
  // No web_accessible_resources entry for the sign-in page, deliberately.
  // web_accessible_resources gates access from WEB contexts (a page fetching
  // or framing an extension resource); opening this page via
  // chrome.runtime.getURL + chrome.tabs.create from the panel, and direct
  // address-bar navigation (how the Task 4 gate opens it), both work without
  // one. An entry here would instead be pure downside for an auth page
  // specifically: with the extension ID pinned by `key` above, any website
  // could probe for this extension and iframe a live sign-in form. See
  // task-4-report.md's fix report for the reasoning and how to tell, from a
  // real gate run, whether this is ever actually needed — if the page will
  // not open without it, add it back scoped (NOT `<all_urls>`) and record
  // that as a finding rather than a precaution.
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
}));
