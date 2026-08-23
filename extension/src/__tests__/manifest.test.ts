// @vitest-environment node
//
// manifest.config.ts is a build-time-only file with no DOM dependency.
// Importing @crxjs/vite-plugin (for defineManifest) pulls in code that
// touches esbuild internals, which breaks under the suite's default jsdom
// environment (jsdom's TextEncoder polyfill violates an invariant esbuild
// relies on). Running this one file under the plain "node" environment
// avoids that entirely — it never needs `document`/`chrome` anyway.
import { describe, it, expect, vi, afterEach } from "vitest";
import manifestExport from "../../manifest.config";
import { BROAD_ORIGINS } from "@/lib/permissions";

// manifest.config.ts exports the function form of `defineManifest` so that
// host_permissions can differ by build mode — verified by reading
// @crxjs/vite-plugin's source (`defineManifest = (manifest) => manifest`, an
// identity function), so calling the export with a Vite ConfigEnv yields the
// plain object the plugin would see for that mode. Narrow the type to the
// shape this repo actually produces rather than fighting the union on every
// assertion.
type Manifest = {
  content_scripts?: unknown;
  permissions?: string[];
  host_permissions?: string[];
  optional_host_permissions?: string[];
  content_security_policy?: { extension_pages?: string };
  icons?: Record<string, string>;
  action?: { default_title?: string; default_icon?: Record<string, string> };
};

function manifestFor(mode: "production" | "development"): Manifest {
  const build = manifestExport as (env: {
    mode: string;
    command: "build";
  }) => Manifest;
  return build({ mode, command: "build" });
}

// The shipped manifest. Everything not explicitly about mode is asserted
// against this one, because it is the one that reaches the Web Store.
const manifest = manifestFor("production");

const JOB_SITES = [
  "*://*.linkedin.com/*",
  "*://*.greenhouse.io/*",
  "*://*.lever.co/*",
  "*://*.ashbyhq.com/*",
  "*://*.myworkdayjobs.com/*",
];

// src/lib/config.ts branches on import.meta.env.MODE, which vitest fixes at
// "test". To read the value a given build would see, stub MODE and import
// the module fresh.
async function clerkFrontendApiFor(mode: string): Promise<string> {
  vi.stubEnv("MODE", mode);
  vi.resetModules();
  const { CLERK_FRONTEND_API } = await import("@/lib/config");
  return CLERK_FRONTEND_API;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("manifest", () => {
  // A content_scripts entry would show "Read and change all your data on all
  // websites" at install — the Web Store friction this design exists to avoid.
  // Page access comes from activeTab + chrome.scripting.executeScript instead.
  it("declares no content_scripts", () => {
    expect("content_scripts" in manifest).toBe(false);
  });

  // Pinned exactly. This list is the Web Store install prompt and, once
  // published, can only shrink without disabling the extension for every
  // existing user — so adding to it should have to be written down twice.
  it("production requests only the live API origins, the production Clerk host, and the five job sites", () => {
    expect(manifest.host_permissions).toEqual([
      "https://career-allpath.com/*",
      "https://www.career-allpath.com/*",
      "https://clerk.career-allpath.com/*",
      ...JOB_SITES,
    ]);
  });

  // localhost and the Clerk dev instance are development-only. A production
  // package that carried them would prompt the reviewer to ask why a shipped
  // extension needs localhost, and would be a wider install prompt for
  // nothing.
  it("development adds localhost and the Clerk dev instance, and nothing ships them", () => {
    expect(manifestFor("development").host_permissions).toEqual([
      "http://localhost:3000/*",
      "https://career-allpath.com/*",
      "https://www.career-allpath.com/*",
      "https://clerk.career-allpath.com/*",
      "https://fair-lemur-34.clerk.accounts.dev/*",
      ...JOB_SITES,
    ]);
    expect(manifest.host_permissions).not.toContain("http://localhost:3000/*");
    expect(
      manifest.host_permissions?.some((h) => h.includes("clerk.accounts.dev")),
    ).toBe(false);
  });

  // Inverted from the assertion this replaced ("requests the cookies
  // permission Clerk needs"), which was wrong: @clerk/chrome-extension's
  // validateManifest requires permissions.cookies only when `features.sync`
  // is set, and `sync` is `Boolean(syncHost)` — lib/clerk.ts passes no
  // syncHost, so nothing in this build reads or writes a cookie through
  // chrome.cookies. Keeping it would widen the Web Store install prompt and
  // grant chrome.cookies access across every host this extension has
  // permission for, buying nothing. If Sync Host is ever adopted, this
  // assertion is the one that has to be revisited deliberately rather than
  // the permission quietly reappearing.
  it("does not request the cookies permission, which only Clerk's unused Sync Host needs", () => {
    expect(manifest.permissions).not.toContain("cookies");
  });

  // Pinned exactly, not just "contains" — a permission added here is a
  // wider install prompt for every existing user, so it should have to be
  // written down twice.
  it("requests exactly the four permissions the extension actually uses", () => {
    expect(manifest.permissions).toEqual([
      "storage",
      "sidePanel",
      "activeTab",
      "scripting",
    ]);
  });

  // Without this the extension cannot reach Clerk at all and sign-in does not
  // exist. It widens the install prompt, which the page-access design worked
  // to keep narrow — an accepted, deliberate cost.
  it("requests the Clerk frontend API host", () => {
    expect(
      manifest.host_permissions?.some((h) => h.includes("clerk")),
    ).toBe(true);
  });

  // manifest.config.ts declares the Clerk host literally (it runs in Node at
  // build time, before src/lib/config.ts's import.meta.env.MODE branching is
  // available to it) rather than importing CLERK_FRONTEND_API. That means
  // nothing at compile time stops the two from drifting apart — this
  // repository has been bitten three times by exactly that shape of bug, a
  // constant load-bearing across two files with nothing pinning them
  // together. If someone changes CLERK_FRONTEND_API in config.ts without
  // updating manifest.config.ts's literal (or vice versa), this is the test
  // that catches it; every other assertion here would stay green because
  // they only look at one side.
  it("does not let the manifest's Clerk host drift from CLERK_FRONTEND_API, in either mode", async () => {
    for (const mode of ["production", "development"] as const) {
      const clerkOrigin = new URL(await clerkFrontendApiFor(mode)).origin;
      expect(manifestFor(mode).host_permissions).toContain(`${clerkOrigin}/*`);
    }
  });

  // Optional host permissions are NOT shown in the install prompt. Declaring
  // them is what lets chrome.permissions.request ask for them later, from a
  // user gesture — requesting an origin that is not declared here fails.
  it("declares the broad origins as OPTIONAL, not granted at install", () => {
    expect(manifest.optional_host_permissions).toEqual([
      "http://*/*",
      "https://*/*",
    ]);
    expect(manifest.host_permissions).not.toContain("http://*/*");
    expect(manifest.host_permissions).not.toContain("https://*/*");
  });

  // These are declared in two files with no compile-time link. A drift makes
  // chrome.permissions.request reject at runtime, where it is caught and
  // returns false — the button silently does nothing, with every test green.
  it("declares exactly the origins the panel will request", () => {
    expect(manifest.optional_host_permissions).toEqual(BROAD_ORIGINS);
  });

  // The PDF layout engine (@react-pdf/layout -> yoga-layout) compiles to
  // WebAssembly. MV3's default extension_pages CSP is `script-src 'self'`,
  // which blocks WASM compilation outright — without 'wasm-unsafe-eval' the
  // Download PDF button throws a CSP CompileError on every click, and every
  // test in this suite (tsc, lint, vitest, vite build) stays green while the
  // feature is completely broken at runtime. This assertion is the only
  // thing that fails if that directive is ever dropped.
  it("allows wasm-unsafe-eval for the PDF layout engine's WebAssembly", () => {
    expect(manifest.content_security_policy?.extension_pages).toContain(
      "'wasm-unsafe-eval'",
    );
  });

  // Without these Chrome shows the default puzzle piece — which is what it
  // showed for the extension's entire life before this.
  it("declares icons at every size Chrome asks for", () => {
    expect(manifest.icons).toEqual({
      "16": "icons/icon-16.png",
      "32": "icons/icon-32.png",
      "48": "icons/icon-48.png",
      "128": "icons/icon-128.png",
    });
  });

  it("gives the toolbar button an icon", () => {
    expect(manifest.action?.default_icon).toEqual({
      "16": "icons/icon-16.png",
      "32": "icons/icon-32.png",
    });
  });
});
