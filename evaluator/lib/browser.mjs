import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { FIXTURE_HOST } from "./fixtureserver.mjs";

/**
 * The extension ID Chrome will assign to an unpacked load.
 *
 * Derived rather than hardcoded: the manifest pins `key`, so the ID is a pure
 * function of it (SHA-256 of the DER public key, first 16 bytes, each nibble
 * mapped 0-f -> a-p). Deriving it means a build whose key changed is caught
 * here instead of showing up as an unexplained 404 on the panel URL.
 */
export async function extensionIdFor(distDir) {
  const manifest = JSON.parse(await readFile(path.join(distDir, "manifest.json"), "utf8"));
  if (!manifest.key) return null;
  const der = Buffer.from(manifest.key, "base64");
  const digest = crypto.createHash("sha256").update(der).digest();
  let id = "";
  for (const byte of digest.subarray(0, 16)) {
    id += String.fromCharCode(97 + (byte >> 4));
    id += String.fromCharCode(97 + (byte & 0x0f));
  }
  return id;
}

/**
 * A fresh persistent profile with the unpacked dev build loaded.
 *
 * A NEW profile every run is a preflight requirement, not hygiene: `cp_beta_code`
 * in chrome.storage.local lifts the quota cap entirely, and a leftover one
 * would make every quota assertion below meaningless (P3).
 */
export async function launchBrowser({ profileDir, distDir, fixturePort, headless, log }) {
  const args = [
    `--disable-extensions-except=${distDir}`,
    `--load-extension=${distDir}`,
    // Points the JD fixture's greenhouse.io hostname at the local fixture
    // server, so the page is covered by an install-time host permission and
    // the panel needs no optional-permission dialog to read it.
    `--host-resolver-rules=MAP ${FIXTURE_HOST} 127.0.0.1:${fixturePort}`,
    // Without this Chrome may silently upgrade the http fixture URL to https,
    // which the fixture server does not speak.
    "--disable-features=HttpsUpgrades,HttpsFirstBalancedMode,AutoupgradeMixedContent",
    "--no-first-run",
    "--no-default-browser-check",
    // The panel is driven while it is a BACKGROUND tab (see panel.mjs for
    // why). These keep Chromium from throttling or freezing it mid-run.
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
  ];

  const context = await chromium.launchPersistentContext(profileDir, {
    headless,
    channel: "chromium",
    args,
    viewport: { width: 1280, height: 900 },
  });
  log(`chromium launched (headless=${headless})`);
  return context;
}

/**
 * Waits for the extension's MV3 service worker, which is also the proof that
 * the extension actually loaded. A load failure otherwise only shows up much
 * later as a blank panel page.
 */
export async function waitForServiceWorker(context, timeoutMs) {
  const existing = context.serviceWorkers();
  if (existing.length > 0) return existing[0];
  return context.waitForEvent("serviceworker", { timeout: timeoutMs });
}
