import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { crx } from "@crxjs/vite-plugin";
import { fileURLToPath } from "node:url";
import manifest from "./manifest.config";

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@shared": fileURLToPath(new URL("../shared", import.meta.url)),
    },
  },
  build: {
    rollupOptions: {
      // CRXJS auto-discovers HTML it finds referenced FROM the manifest
      // (side_panel's default_path, background, content scripts). The
      // sign-in page is reached only via chrome.runtime.getURL — nothing in
      // the manifest points at it — so it needs an explicit input or CRXJS
      // never emits it at all.
      input: {
        signin: fileURLToPath(new URL("./src/signin/index.html", import.meta.url)),
      },
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
