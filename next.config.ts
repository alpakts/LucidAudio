import type { NextConfig } from "next";
import pkg from "./package.json";

const nextConfig: NextConfig = {
  // Sayfanın altında görünen sürüm; her yayında package.json'daki "version" artırılır.
  env: { NEXT_PUBLIC_APP_VERSION: pkg.version },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
