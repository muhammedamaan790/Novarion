// Flow C (plan §1A, §17 demo beat 0:20–0:40): import a case file → quality gate → prediction → 3D.
import { expect, test } from "@playwright/test";

const SAMPLES = "public/samples";
const REAL = process.env.E2E_BACKEND === "real";
const SHOTS = REAL ? "../results/ui/real" : "../results/ui";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("page-new").click();
});

test("dataset-record CSV: labels stripped, provenance recognised, OOF result one click away", async ({ page }) => {
  await page.getByTestId("import-file").setInputFiles(`${SAMPLES}/dataset_patient_ZAS-0003.csv`);
  const report = page.getByTestId("import-report");
  await expect(report).toContainText("Recognized 52 fields");
  await expect(report).toContainText("Leakage fields ignored (outcome labels are never model inputs): Cath, LAD, LCX, RCA");
  await expect(page.getByTestId("unit-confirm")).toHaveCount(0); // every continuous column carries its unit
  await expect(page.getByTestId("case-status")).toContainText("Prediction up to date", { timeout: 15_000 });
  await expect(page.getByTestId("case-status")).toContainText("Matches the dataset record");
  await expect(page.getByTestId("live-summary")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/8-import-dataset.png` });
  await page.getByTestId("open-oof").click();
  await expect(page.getByText("OOF VALIDATION")).toBeVisible();
  await expect(page).toHaveURL(/dataset=ZAS-0003/);
});

test("synthetic JSON: ambiguous units must be confirmed; UNKNOWN forces LOW confidence", async ({ page }) => {
  await page.getByTestId("import-file").setInputFiles(`${SAMPLES}/synthetic_case.json`);
  await expect(page.getByTestId("import-report")).toContainText("Recognized 52 fields");
  await expect(page.getByTestId("unit-confirm")).toBeVisible();
  await expect(page.getByTestId("case-status")).toContainText("Blocked", { timeout: 15_000 });
  await page.getByText("I confirm these values are in the units shown").click();
  await expect(page.getByTestId("case-status")).toContainText("Prediction up to date", { timeout: 15_000 });
  for (const t of ["cad", "lad", "lcx", "rca"]) {
    await expect(page.getByTestId(`card-${t}`)).toContainText("LOW MODEL CONFIDENCE");
  }
  await expect(page.getByTestId("card-cad")).toContainText("an input was marked UNKNOWN");
  await page.screenshot({ path: `${SHOTS}/9-import-synthetic.png` });
});

test("multi-row CSV: one row is chosen, one row = one case", async ({ page }) => {
  await page.getByTestId("import-file").setInputFiles(`${SAMPLES}/three_dataset_patients.csv`);
  await expect(page.getByTestId("import-report")).toContainText("3 rows");
  await page.getByTestId("import-row").selectOption({ label: "ZAS-0006" });
  await expect(page.getByTestId("case-status")).toContainText("Prediction up to date", { timeout: 15_000 });
});
