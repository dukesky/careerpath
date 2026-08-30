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

// The origins allowed to navigate to the sign-in page — see
// web_accessible_resources below for why this exists and why it is a
// deliberately short list. Both Clerk hosts are included because the OAuth
// return leg can come from either the Frontend API host or the account
// portal, and which one it is depends on Clerk's own flow rather than on
// anything this extension controls. Both modes are listed unconditionally:
// unlike host_permissions, this grants no access to the developer instance —
// it only names who may open a page that is itself Clerk-gated.
const CLERK_WEB_ORIGINS = [
  "https://clerk.career-allpath.com/*",
  "https://accounts.career-allpath.com/*",
  "https://fair-lemur-34.clerk.accounts.dev/*",
  "https://accounts.fair-lemur-34.clerk.accounts.dev/*",
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
  // Pins the extension ID (epofgiefihhmbjhojdeffkdkhocjfpaf) across local
  // unpacked loads, matching the Chrome Web Store listing: this is the public
  // key the store generated at first upload (Developer Dashboard -> Package
  // -> View public key), so an unpacked dist/ and the store-installed copy
  // share one ID. The server's CORS allowlist (ALLOWED_EXTENSION_IDS) and
  // Clerk's allowed_origins key on that ID, so an ID that drifts looks like
  // CORS spontaneously breaking. Public key only — the matching private key
  // lives with the Web Store, not in this repo. scripts/package.mjs strips
  // this field from store uploads, which is required on a first upload and
  // harmless after.
  key: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAt+XioLle+9hJXo9o2emK9lksiWh9EYCyiBe+FKvVRPCr3Ub4EXdP84ndCTQlzYvvdWFahg7y/M5OT3rIHNOQb5dNzA/XMRBoc9tPTRDcrDpDL7KvdMnRqRdEF+wvCJZn1lgRmDBCqopXxDSpbjaqOw1lb5ldB9GvZUzK9+oaDz/YkL9T3oLG8+/PnL7QnyNbppU/SnONjOo5uiDZbTBsPbwjI4z03ulyncDUwOFlPLokPMBp8CzDSLAoU8ZxIjwDde2LLVL38gBGt1RGntf2eJgFw6WgCsQrJXs1AoCu3oUlDdn0CCdoGT4Cqwhn6t2BIzQd4H3C9DgJVq8s2mY6YQIDAQAB",
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
  // The sign-in page IS web-accessible, but only to Clerk's own origins.
  //
  // This entry was removed once, on the reasoning that the two ways the page
  // gets opened — chrome.runtime.getURL from the panel, and address-bar
  // navigation — both work without it, so exposing an auth page was pure
  // downside. Both halves of that were true; the list of ways was not.
  //
  // The OAuth return leg is a third way, and it is a WEB navigation: after
  // Google, Clerk sends the browser from its own origin to this page. Chrome
  // blocks that with ERR_BLOCKED_BY_CLIENT unless the page is listed here —
  // observed in a real browser, which is the only place it shows up. Email
  // sign-in never hits this because it needs no redirect back, so the gap
  // survived every test and one round of live verification.
  //
  // `matches` is Clerk's origins ONLY, never <all_urls>. That preserves what
  // removing the entry was protecting against: with the extension ID pinned
  // by `key` above, an <all_urls> entry would let any website probe for this
  // extension and iframe a live sign-in form. Clerk's origins can already
  // drive the sign-in flow, so they gain nothing they did not have.
  web_accessible_resources: [
    {
      resources: ["src/signin/index.html"],
      matches: CLERK_WEB_ORIGINS,
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
}));
