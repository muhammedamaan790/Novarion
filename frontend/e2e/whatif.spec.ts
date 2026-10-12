// Tier-3 what-if sensitivity (plan §6): final-model analyses only; dataset patients keep their out-of-fold model.
import { expect, test } from "@playwright/test";

const FIRST_LOAD = { timeout: 30_000 };

test("what-if curves for a new case, labelled as model sensitivity", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("tab-new").click();
  await page.getByLabel("Prefill from a dataset patient").selectOption("ZAS-0004");
  await expect(page.getByTestId("case-status")).toContainText("Prediction up to date", FIRST_LOAD);
  await page.getByTestId("select-lad").click();
  await page.getByTestId("whatif-toggle").click();
  const panel = page.getByTestId("whatif");
  await expect(panel).toContainText("Model sensitivity, not treatment simulation");
  await expect(panel.locator("li").first()).toBeVisible(FIRST_LOAD);
  await expect(panel).toContainText("pt range");
  await expect(panel.locator("[data-testid='whatif-age'], [data-testid='whatif-sex']")).toHaveCount(0); // locked
});

test("dataset patients explain why what-if needs a new case", async ({ page }) => {
  await page.goto("/?dataset=ZAS-0003&target=lad");
  await expect(page.getByTestId("why-panel")).toBeVisible(FIRST_LOAD);
  await page.getByTestId("whatif-toggle").click();
  await expect(page.getByTestId("whatif")).toContainText("out-of-fold model that never saw them");
});
