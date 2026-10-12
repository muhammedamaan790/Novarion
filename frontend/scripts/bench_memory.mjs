// Browser memory + offline index parse time → results/perf.json "browser" (plan §11A "measured parse time and peak
// tab memory recorded in perf.json"). Offline demo mode (API blocked) is the worst case: every patient is read from
// the static bundle in the tab. Opens 30 patients in a row and samples the JS heap after each (CDP metrics).
// Usage: node scripts/bench_memory.mjs [--url http://127.0.0.1:5173] (a dev or preview server must be running)
import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const url = arg("--url", "http://127.0.0.1:5173");
const channel = process.env.PW_CHANNEL ?? "msedge";
const browser = await chromium.launch({ channel });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.route("**/api/v1/**", (route) => route.abort()); // offline demo mode
const cdp = await page.context().newCDPSession(page);
await cdp.send("Performance.enable");
const heapMb = async () => {
  await cdp.send("HeapProfiler.collectGarbage");
  const { metrics } = await cdp.send("Performance.getMetrics");
  return metrics.find((m) => m.name === "JSHeapUsedSize").value / 2 ** 20;
};

await page.goto(url);
await page.getByTestId("run-mode").waitFor({ timeout: 30_000 });
const parse = await page.evaluate(async () => {
  const t0 = performance.now();
  const text = await (await fetch("/demo_bundle/index.json", { cache: "no-store" })).text();
  const t1 = performance.now();
  const doc = JSON.parse(text);
  const t2 = performance.now();
  return { fetch_ms: t1 - t0, parse_ms: t2 - t1, kb: text.length / 1024, patients: doc.index.patients.length };
});
const baseline = await heapMb();
const samples = [];
const ids = await page.locator("[data-testid^='patient-ZAS-']").evaluateAll((els) => els.slice(0, 30).map((e) => e.dataset.testid));
for (const id of ids) {
  await page.getByTestId(id).click();
  await page.getByTestId("card-cad").waitFor({ timeout: 30_000 });
  await page.waitForTimeout(150);
  samples.push(await heapMb());
}
await browser.close();

const browserReport = {
  measured_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  mode: "offline demo mode (static bundle), production build of the same frontend code",
  channel, url,
  index: { kb: Math.round(parse.kb), patients: parse.patients, fetch_ms: +parse.fetch_ms.toFixed(1), parse_ms: +parse.parse_ms.toFixed(1) },
  js_heap_mb: { after_load: +baseline.toFixed(1), after_30_patients: +samples.at(-1).toFixed(1),
                peak: +Math.max(...samples).toFixed(1), patients_opened: samples.length },
};
const perfPath = resolve("../results/perf.json");
const perf = JSON.parse(readFileSync(perfPath, "utf8"));
perf.browser = browserReport;
writeFileSync(perfPath, JSON.stringify(perf, null, 1) + "\n");
console.log(JSON.stringify(browserReport, null, 1));
