// Clinical-standard evidence on the Model Evidence page (D-021): guideline pretest score comparison + subgroups.
import { expect, test } from "@playwright/test";

test("Model Evidence compares CAD with the guideline pretest score and shows subgroups per target", async ({ page }) => {
  await page.goto("/?page=evidence");
  const panel = page.getByTestId("clinical-benchmark");
  await expect(panel).toContainText("CAD versus the guideline pretest score", { timeout: 30_000 });
  await expect(panel).toContainText("Diamond–Forrester (published)");
  await expect(panel).toContainText("does not recommend tests or treatment");
  await page.getByTestId("evidence-lcx").click();
  await expect(panel).toContainText("Subgroup performance · LCX");
  await expect(page.getByTestId("subgroup-table").locator("tbody tr")).toHaveCount(6);
  await panel.screenshot({ path: `${process.env.E2E_BACKEND === "real" ? "../results/ui/real" : "../results/ui"}/14-clinical.png` });
});
