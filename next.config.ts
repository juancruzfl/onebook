import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // chainsig.js pulls in many chain SDKs; load it from node_modules at runtime instead of bundling it.
  serverExternalPackages: ["chainsig.js"],
  // Lets a production build run next to a dev server without sharing .next (e.g. NEXT_DIST_DIR=.next-build).
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;
