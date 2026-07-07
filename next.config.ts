import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep native/heavy parsers out of the bundler; load them at runtime.
  serverExternalPackages: ["unpdf", "mammoth", "jsdom", "@mozilla/readability"],
};

export default nextConfig;
