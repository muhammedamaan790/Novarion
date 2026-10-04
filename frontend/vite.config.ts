/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

declare const process: { env: Record<string, string | undefined> };

// The dev server proxies /api to the backend (mock: NOVARION_MOCK=1, see README), so the app is same-origin.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: { "/api": { target: process.env.NOVARION_API ?? "http://127.0.0.1:8000", changeOrigin: false } },
  },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
