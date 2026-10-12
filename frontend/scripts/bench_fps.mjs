// 3D frame-rate benchmark (plan §9.5): scripted 30 s interaction (continuous orbit drag + vessel selections + view
// presets) on a dataset patient, measuring browser frame intervals; records the GPU renderer string so the result is
// attributable. Writes results/perf.json → "fps". Usage: node scripts/bench_fps.mjs [--url http://127.0.0.1:8080]
import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const url = process.argv.includes("--url") ? process.argv[process.argv.indexOf("--url") + 1] : "http://127.0.0.1:8080";
const seconds = 30;
const browser = await chromium.launch({
  channel: process.env.PW_CHANNEL ?? "msedge",
  args: ["--ignore-gpu-blocklist", "--enable-gpu", "--use-angle=d3d11", "--enable-unsafe-swiftshader=false"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto(`${url}/?dataset=ZAS-0003`);
await page.getByTestId("card-cad").waitFor({ timeout: 60_000 });
await page.waitForTimeout(1500);
const gpu = await page.evaluate(() => {
  const gl = document.createElement("canvas").getContext("webgl2");
  const info = gl?.getExtension("WEBGL_debug_renderer_info");
  return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : "unknown";
});
const triangles = 131990;
await page.evaluate(() => {
  window.__frames = [];
  const tick = (t) => { window.__frames.push(t); window.__raf = requestAnimationFrame(tick); };
  window.__raf = requestAnimationFrame(tick);
});
const box = await page.locator("canvas").boundingBox();
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;
const start = Date.now();
let step = 0;
const actions = ["select-lad", "select-lcx", "select-rca", "compare-all", "view-body", "select-cad"];
while (Date.now() - start < seconds * 1000) {
  // a continuous orbit drag (the heaviest steady interaction), interleaved with selections and preset flights
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 0; i < 40; i++) await page.mouse.move(cx + 220 * Math.sin(i / 6), cy + 60 * Math.cos(i / 9), { steps: 2 });
  await page.mouse.up();
  await page.getByTestId(actions[step++ % actions.length]).click();
  await page.waitForTimeout(400);
}
const frames = await page.evaluate(() => { cancelAnimationFrame(window.__raf); return window.__frames; });
await browser.close();
const intervals = frames.slice(1).map((t, i) => t - frames[i]).filter((d) => d > 0 && d < 1000);
const fps = intervals.map((d) => 1000 / d).sort((a, b) => a - b);
const q = (p) => fps[Math.min(fps.length - 1, Math.floor(p * (fps.length - 1)))];
const result = {
  measured_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), url, gpu_renderer: gpu,
  software_rendering: /swiftshader|llvmpipe|software/i.test(gpu), browser: `${process.env.PW_CHANNEL ?? "msedge"} (Playwright, headless)`,
  viewport: "1600x900", dpr: 1, triangles, scenario: "30 s: continuous orbit drags + vessel selections + compare + whole-body preset",
  frames: fps.length, median_fps: Math.round(q(0.5) * 10) / 10, p5_fps: Math.round(q(0.05) * 10) / 10,
  acceptance: "median >= 45 fps on an integrated GPU (plan §9.5); design goal 60 fps",
};
const path = resolve("../results/perf.json");
const perf = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
perf.fps = result;
writeFileSync(path, JSON.stringify(perf, null, 1) + "\n");
console.log(`GPU: ${gpu}\nmedian ${result.median_fps} fps · p5 ${result.p5_fps} fps over ${result.frames} frames`);
