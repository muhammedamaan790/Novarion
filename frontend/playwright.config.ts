import { defineConfig } from "@playwright/test";

// E2E against the contract mock backend (NOVARION_MOCK=1) + the Vite dev server. Uses the system Edge/Chrome
// channel (no browser download); override with PW_CHANNEL=chrome or chromium.
const channel = process.env.PW_CHANNEL ?? "msedge";
// E2E_BACKEND=real runs the same flows against the trained bundle instead of the contract mock.
const real = process.env.E2E_BACKEND === "real";

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  use: { baseURL: "http://127.0.0.1:5173", channel, viewport: { width: 1440, height: 900 } },
  webServer: [
    {
      command: "uv run --group inference uvicorn app.main:app --app-dir backend --port 8000",
      cwd: "..",
      env: real ? { PYTHONPATH: "ml" } : { NOVARION_MOCK: "1", PYTHONPATH: "ml" },
      url: "http://127.0.0.1:8000/api/v1/health/ready",
      reuseExistingServer: !process.env.CI && !real,
      timeout: 120_000,
    },
    { command: "npm run dev -- --host 127.0.0.1", url: "http://127.0.0.1:5173", reuseExistingServer: true },
  ],
});
