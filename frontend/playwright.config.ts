import { defineConfig } from "@playwright/test";

// E2E against the contract mock backend (NOVARION_MOCK=1) + the Vite dev server. Uses the system Edge/Chrome
// channel (no browser download); override with PW_CHANNEL=chrome or chromium.
// PW_BROWSER=firefox|webkit switches engine; for Chromium, PW_CHANNEL picks the installed browser (msedge, chrome).
const browserName = (process.env.PW_BROWSER ?? "chromium") as "chromium" | "firefox" | "webkit";
const channel = browserName === "chromium" ? process.env.PW_CHANNEL ?? "msedge" : undefined;
// E2E_BACKEND=real runs the same flows against the trained bundle instead of the contract mock.
const real = process.env.E2E_BACKEND === "real";
// E2E_BASE_URL=http://127.0.0.1:8080 tests an already-running deployment (e.g. docker compose) instead of dev servers.
const external = process.env.E2E_BASE_URL;

// E2E_API_PORT / E2E_WEB_PORT move the test servers when 8000/5173 are taken by something else.
const apiPort = process.env.E2E_API_PORT ?? "8000";
const webPort = process.env.E2E_WEB_PORT ?? "5173";

export default defineConfig({
  testDir: "e2e",
  // On CI, every failure also becomes a GitHub annotation (readable on the run page and via the public API).
  reporter: process.env.CI ? [["github"], ["list"], ["html", { open: "never" }]] : "list",
  timeout: 60_000,
  expect: { timeout: 10_000 }, // the real backend computes explanations on demand; give it headroom under load
  // headless software WebGL: parallel browsers starve each other on a small CPU (real backend, 2-core CI runners)
  workers: real || process.env.CI ? 1 : undefined,
  use: { baseURL: external ?? `http://127.0.0.1:${webPort}`, browserName, channel, viewport: { width: 1440, height: 900 } },
  webServer: external ? undefined : [
    {
      command: `uv run --group inference uvicorn app.main:app --app-dir backend --port ${apiPort}`,
      cwd: "..",
      env: real ? { PYTHONPATH: "ml" } : { NOVARION_MOCK: "1", PYTHONPATH: "ml" },
      url: `http://127.0.0.1:${apiPort}/api/v1/health/ready`,
      reuseExistingServer: !process.env.CI, // a wrong reused backend fails the mock-identity test loudly
      timeout: 120_000,
    },
    { command: `npm run dev -- --host 127.0.0.1 --port ${webPort} --strictPort`, url: `http://127.0.0.1:${webPort}`,
      env: { NOVARION_API: `http://127.0.0.1:${apiPort}` }, reuseExistingServer: webPort === "5173" },
  ],
});
