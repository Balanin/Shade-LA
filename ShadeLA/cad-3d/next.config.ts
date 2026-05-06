import type { NextConfig } from "next";

import path from "path";
import * as dotenv from "dotenv";

dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const basePath = "/Shade-LA";

const nextConfig: NextConfig = {
  output: "export",
  basePath,
  assetPrefix: `${basePath}/`,
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
  env: {
    NEXT_PUBLIC_CESIUM_ION_TOKEN: process.env.CESIUM_ION_TOKEN,
    NEXT_PUBLIC_CESIUM_BASE_URL: `${basePath}/cesium`,
  },
  turbopack: {},
  // Ensure these packages are resolved at runtime in Node, not bundled by Turbopack
  serverExternalPackages: [
    "rhino3dm",
    "ws",
    "@xmldom/xmldom",
    "osmtogeojson",
    "earcut",
    "jszip"
  ],
};

export default nextConfig;
