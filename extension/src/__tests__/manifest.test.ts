// @vitest-environment node
//
// manifest.config.ts is a build-time-only file with no DOM dependency.
// Importing @crxjs/vite-plugin (for defineManifest) pulls in code that
// touches esbuild internals, which breaks under the suite's default jsdom
// environment (jsdom's TextEncoder polyfill violates an invariant esbuild
// relies on). Running this one file under the plain "node" environment
// avoids that entirely — it never needs `document`/`chrome` anyway.
import { describe, it, expect } from "vitest";
import manifestExport from "../../manifest.config";

// `defineManifest` is typed to return `ManifestV3 | Promise<ManifestV3> |
// ManifestV3Fn` so it can support all three authoring styles, but this
// project always calls it with a plain object literal — verified by reading
// @crxjs/vite-plugin's source (`defineManifest = (manifest) => manifest`),
// an identity function. Narrow the import's type here to the shape this repo
// actually produces, rather than fighting the union on every assertion.
const manifest = manifestExport as {
  content_scripts?: unknown;
  host_permissions?: string[];
  optional_host_permissions?: string[];
};

describe("manifest", () => {
  // A content_scripts entry would show "Read and change all your data on all
  // websites" at install — the Web Store friction this design exists to avoid.
  // Page access comes from activeTab + chrome.scripting.executeScript instead.
  it("declares no content_scripts", () => {
    expect("content_scripts" in manifest).toBe(false);
  });

  it("requests the API origins plus exactly the five supported job sites", () => {
    expect(manifest.host_permissions).toEqual([
      "http://localhost:3000/*",
      "https://careerpath-hazel.vercel.app/*",
      "*://*.linkedin.com/*",
      "*://*.greenhouse.io/*",
      "*://*.lever.co/*",
      "*://*.ashbyhq.com/*",
      "*://*.myworkdayjobs.com/*",
    ]);
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
});
