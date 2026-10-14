/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import releaseManifest from "../release_manifest.json";

declare const process: { env: Record<string, string | undefined> };

// The dev server proxies /api to the backend (mock: NOVARION_MOCK=1, see README), so the app is same-origin.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The offline bundle is verified against hashes pinned by the committed release manifest (audit R03/R18).
  define: {
    __RELEASE_PINS__: JSON.stringify({
      demo_bundle_sha256: (releaseManifest as { demo_bundle_sha256?: string }).demo_bundle_sha256 ?? null,
      demo_static_sha256: (releaseManifest as { demo_static_sha256?: string }).demo_static_sha256 ?? null,
    }),
  },
  server: {
    port: 5173,
    proxy: { "/api": { target: process.env.NOVARION_API ?? "http://127.0.0.1:8000", changeOrigin: false } },
  },
  // The 3D engine (three.js + React Three Fiber + drei, ~675 kB) is one indivisible chunk, loaded only on pages that show
  // a heart; the app shell is ~510 kB. Warn above that, so a real regression still shows up.
  build: { chunkSizeWarningLimit: 700 },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
