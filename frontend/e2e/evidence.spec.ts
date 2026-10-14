// Model Evidence acceptance (D-035): every tab loads for every target, confidence tiers reconcile and say "not estimable"
// rather than 0%, exports equal the evaluation outputs they plot, tabs work from the keyboard, no axe violations, and no
// horizontal scroll on a phone. Confidence tiers and the guideline file are static evidence, the same on mock and real.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

const REAL = process.env.E2E_BACKEND === "real";
const TARGETS = ["cad", "lad", "lcx", "rca"] as const;
const TABS = ["summary", "performance", "confidence", "curves", "clinical", "methods"] as const;

async function download(page: Page, testId: string): Promise<string> {
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByTestId(testId).click()]);
  return readFileSync((await dl.path())!, "utf8");
}

function parseCsv(text: string): Record<string, string>[] {
  const [head, ...lines] = text.trim().split("\n");
  const cols = head!.split(",");
  return lines.map((l) => Object.fromEntries(l.split(",").map((v, i) => [cols[i]!, v])));
}

async function openEvidence(page: Page) {
  await page.goto("/?page=evidence");
  await expect(page.getByTestId("evidence-page")).toBeVisible({ timeout: 30_000 });
}

test("every evidence tab loads for every target without page errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !m.location().url.includes("favicon")) errors.push(m.text()); });
  await openEvidence(page);
  await expect(page.getByTestId("evidence-disclaimer")).toContainText("Research and education only");
  for (const t of TARGETS) {
    await page.getByTestId(`evidence-${t}`).click();
    for (const s of TABS) {
      await page.getByTestId(`evidence-section-${s}`).click();
      await expect(page.getByTestId(`evidence-section-${s}`)).toHaveAttribute("aria-selected", "true");
      await expect(page.getByRole("tabpanel")).not.toBeEmpty();
    }
  }
  await page.getByTestId("evidence-section-methods").click();
  await expect(page.getByTestId("evidence-unavailable")).toContainText("ESC 2024");
  expect(errors).toEqual([]);
});

test("confidence tiers reconcile, and an empty tier is 'not estimable', never 0%", async ({ page }) => {
  await openEvidence(page);
  await page.getByTestId("evidence-section-confidence").click();
  await expect(page.getByTestId("tier-card-pos")).toContainText("44.6%");
  await expect(page.getByTestId("tier-card-pos")).toContainText("135 of 303 patients");
  await expect(page.getByTestId("tier-card-ppv")).toContainText("98.5%");
  await expect(page.getByTestId("tier-card-ppv")).toContainText("96.2%–100.0%");
  await expect(page.getByTestId("tier-card-npv")).toContainText("not estimable");
  await expect(page.getByTestId("tier-card-out")).toContainText("55.4%");
  await expect(page.getByTestId("tier-reconcile"))
    .toHaveText("135 qualified positive + 0 qualified negative + 168 outside = 303 of 303 patients ✓");
  await expect(page.getByTestId("tier-reasons")).toContainText("counts overlap");
  for (const t of ["lad", "lcx", "rca"]) {
    await page.getByTestId(`evidence-${t}`).click();
    await expect(page.getByTestId("tier-card-pos")).toContainText("0.0%");
    await expect(page.getByTestId("tier-card-ppv")).toContainText("not estimable");
    await expect(page.getByTestId("tier-card-out")).toContainText("100.0%");
  }
  await expect(page.getByTestId("tiers-displayed").locator("tbody tr").nth(1)).toContainText("not estimable · 0 qualified");
});

test("exports contain exactly the evaluation data the page plots", async ({ page, request }) => {
  await openEvidence(page);
  // ROC-AUC by target (JSON) equals the evaluation's selected-model rows (null where the bundle has none, e.g. the mock)
  const evaluation = await (await request.get("/api/v1/evaluation")).json(); // the bare evaluation (no envelope)
  const auc = JSON.parse(await download(page, "export-auc-by-target-json"));
  for (const t of TARGETS) {
    const row = evaluation.table1.find((r: { target: string; model: string }) => r.target === t && r.model === "nested_cv_selected");
    const got = auc.rows.find((r: { target: string }) => r.target === t);
    expect(got.mean).toBe(row?.metrics.roc_auc?.mean ?? null);
    expect(got.sd).toBe(row?.metrics.roc_auc?.sd ?? null);
  }
  // Displayed tiers (CSV) equal the bound evidence file, unrounded
  await page.getByTestId("evidence-section-confidence").click();
  const tiers = (await (await request.get("/evidence/displayed_tiers.json")).json()).data.targets;
  const rows = parseCsv(await download(page, "export-tiers-displayed-csv"));
  expect(rows.map((r) => r.target)).toEqual([...TARGETS]);
  for (const r of rows) {
    const src = tiers[r.target!];
    expect(Number(r.qualified_positive_share)).toBe(src.pct_high_positive);
    expect(Number(r.qualified_positive_n)).toBe(src.n_high_positive);
    expect(r.ppv === "" ? null : Number(r.ppv)).toBe(src.ppv);
    expect(Number(r.outside_share)).toBe(src.pct_low_confidence);
  }
  // Subgroups (CSV) equal the clinical evaluation file
  await page.getByTestId("evidence-section-clinical").click();
  const sub = (await (await request.get("/evidence/clinical_evaluation.json")).json()).data.subgroups.cad;
  const subRows = parseCsv(await download(page, "export-subgroups-cad-csv"));
  expect(subRows).toHaveLength(Object.keys(sub).length);
  for (const r of subRows) expect(Number(r.auc)).toBe(sub[r.subgroup!].auc);
  if (REAL) {
    // Threshold sweep: suppressed points are exported as suppressed, never as a value
    await page.getByTestId("evidence-section-curves").click();
    const sweep = parseCsv(await download(page, "export-threshold-sweep-cad-csv"));
    expect(sweep.length).toBe(evaluation.figures.cad.threshold_sweep.length);
    for (const r of sweep) if (Number(r.n_above) < 15) expect(r.ppv_shown).toBe("");
  }
});

test("evidence tabs and targets work from the keyboard; info tips open on focus", async ({ page }) => {
  await openEvidence(page);
  await page.getByTestId("evidence-section-summary").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("evidence-section-performance")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("evidence-section-performance")).toBeFocused();
  await page.keyboard.press("End");
  await expect(page.getByTestId("evidence-section-methods")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Home");
  await expect(page.getByTestId("evidence-section-summary")).toHaveAttribute("aria-selected", "true");
  await page.getByTestId("evidence-cad").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("evidence-lad")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("evidence-key-numbers")).toContainText("Sensitivity · LAD");
  await page.getByRole("button", { name: "About Sensitivity" }).focus();
  await expect(page.getByRole("tooltip").filter({ hasText: "operating threshold" })).toBeVisible();
});

test("curves name the deployed thresholds and explain suppression", async ({ page }) => {
  test.skip(!REAL, "the contract mock has no figures");
  await openEvidence(page);
  await page.getByTestId("evidence-section-curves").click();
  await expect(page.getByTestId("curve-roc")).toContainText("AUC 0.931");
  await expect(page.getByTestId("threshold-key")).toContainText("t_op = 0.695");
  await expect(page.getByTestId("threshold-key")).toContainText("t_neg = none");
  await expect(page.getByTestId("sweep-suppression")).toContainText("fewer than 15");
  await expect(page.getByTestId("reliability-bins").locator("tbody tr")).toHaveCount(5);
});

for (const s of TABS) {
  test(`accessibility: no serious or critical axe violations on the evidence ${s} tab`, async ({ page }) => {
    await openEvidence(page);
    await page.getByTestId(`evidence-section-${s}`).click();
    await page.waitForTimeout(800);
    const results = await new AxeBuilder({ page }).exclude("canvas").analyze();
    const bad = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(bad.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`)).toEqual([]);
  });
}

test("on a phone the evidence page never scrolls sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openEvidence(page);
  for (const s of TABS) {
    await page.getByTestId(`evidence-section-${s}`).click();
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  }
});
