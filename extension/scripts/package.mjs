// Packages dist/ into the zip the Chrome Web Store accepts.
//
// Two things this does that "zip -r dist" would not:
//
// 1. The archive root is the CONTENTS of dist/, not a dist/ folder —
//    the store looks for manifest.json at the top level.
// 2. The manifest's "key" field is stripped. The store rejects a FIRST
//    upload whose manifest carries "key" ("key field not allowed in
//    manifest"); on later uploads it ignores the field. Stripping it every
//    time is the one rule that is right in both cases. The "key" in
//    manifest.config.ts exists so that a locally loaded unpacked build gets
//    a stable ID — after the first store upload, replace it with the public
//    key the Developer Dashboard shows under Package > View public key, so
//    the unpacked and the store-installed copies share one ID.
//
// Run `npm run build` first; this does not build.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const dist = join(root, "dist");
if (!existsSync(join(dist, "manifest.json"))) {
  console.error("dist/manifest.json not found — run `npm run build` first");
  process.exit(1);
}

const staging = mkdtempSync(join(tmpdir(), "career-path-extension-"));
cpSync(dist, staging, { recursive: true });

const manifestPath = join(staging, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
delete manifest.key;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

const out = join(root, `career-path-extension-${manifest.version}.zip`);
rmSync(out, { force: true });
execFileSync("zip", ["-qr", out, ".", "-x", ".*", "-x", "*/.*"], { cwd: staging });
rmSync(staging, { recursive: true, force: true });

console.log(`wrote ${out}`);
console.log(`version ${manifest.version}`);
console.log(`host_permissions: ${manifest.host_permissions.join(", ")}`);
