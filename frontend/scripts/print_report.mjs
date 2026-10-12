// Print docs/report.html → docs/report.pdf with the system browser (A4, CSS @page margins). Reports the page count.
import { chromium } from "@playwright/test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const channel = process.env.PW_CHANNEL ?? "msedge";
const html = resolve("../docs/report.html");
const browser = await chromium.launch({ channel });
const page = await browser.newPage();
await page.goto(pathToFileURL(html).href, { waitUntil: "load" });
const pdf = await page.pdf({ path: resolve("../docs/report.pdf"), format: "A4", preferCSSPageSize: true, printBackground: true });
await browser.close();
const pages = (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
console.log(`docs/report.pdf written: ${pages} page(s)`);
if (pages > 6) process.exitCode = 1; // the brief allows at most 6 pages
