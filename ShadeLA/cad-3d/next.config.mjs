/** @type {import('next').NextConfig} */
import path from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
try {
  const dotenv = require("dotenv");
  dotenv.config({ path: path.resolve(process.cwd(), "..", ".env"), override: false });
} catch {
  // ignore
}

const isPagesBuild =
  process.env.NEXT_PUBLIC_DEPLOY_TARGET === "pages" ||
  process.env.GITHUB_ACTIONS === "true";

const basePath = isPagesBuild ? "/Shade-LA/cad-3d" : "";

const nextConfig = {
  output: "export",
  basePath,
  assetPrefix: basePath ? `${basePath}/` : undefined,
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
  env: {
    NEXT_PUBLIC_CESIUM_ION_TOKEN: process.env.CESIUM_ION_TOKEN,
    NEXT_PUBLIC_CESIUM_BASE_URL: `${basePath || ""}/cesium`
  },
  turbopack: {},
  serverExternalPackages: [
    'rhino3dm',
    'ws',
    '@xmldom/xmldom',
    'osmtogeojson',
    'earcut',
    'jszip'
  ]
};

export default nextConfig;
