import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep native/heavy parsers out of the bundler; load them at runtime.
  // (jsdom removed — replaced by linkedom/he, which bundle fine and avoid an
  // ESM/CJS crash in jsdom's transitive deps on Vercel.)
  serverExternalPackages: ["unpdf", "mammoth"],
};

export default nextConfig;
