import type { NextConfig } from "next";
import path from "node:path";
/**
 * NEXT_BUILD_MODE=desktop  →  static export for Electron (FloDesktop)
 * NEXT_BUILD_MODE unset    →  standard Next.js server mode (FloPOS cloud)
 */
const isDesktop = process.env.NEXT_BUILD_MODE === "desktop";

const nextConfig: NextConfig = {
  // Static export: required for Electron — served via embedded Express,
  // not file:// so no CORS/routing issues.
  output: isDesktop ? "export" : undefined,

  // Trailing slashes make static paths predictable: /pos → /pos/index.html
  trailingSlash: isDesktop,

  // next/image optimisation requires a running server; disable for static export.
  images: {
    unoptimized: isDesktop,
  },

  // Dev-only API proxy for `npm run hot`: when the Electron window loads this
  // Next dev server (for fast refresh) instead of the static export, forward
  // /api calls to the Electron/backend Express server so the app works live.
  // Omitted entirely in the static export build (rewrites are unsupported and
  // Next warns if the key is present at all).
  ...(isDesktop ? {} : {
    async rewrites() {
      const backend = process.env.FLO_BACKEND_ORIGIN || 'http://localhost:3001';
      return [{ source: '/api/:path*', destination: `${backend}/api/:path*` }];
    },
  }),

  // Silence the "multiple lockfiles / inferred workspace root" warning.
  // Allow imports from /main (countries derivation shared with backend) via alias;
  // root must encompass both frontend/ and main/, so it points at the repo root.
  turbopack: {
    root: path.resolve(process.cwd(), '..'),
    resolveAlias: {
      '@countries': '../main/countries.ts',
    },
  },
};

export default nextConfig;
