import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // chainsig.js pulls in many chain SDKs; load it from node_modules at runtime instead of bundling it.
  serverExternalPackages: ["chainsig.js"],
};

export default nextConfig;
