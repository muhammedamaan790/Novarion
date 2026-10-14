// Risk factors tab (D-034): the modifiable risk factors in the recorded values, as education, never advice.
import { expect, test } from "@playwright/test";

const FIRST_LOAD = { timeout: 30_000 };

test("risk factors: a smoker with otherwise normal values gets exactly one card, framed as education", async ({ page }) => {
  await page.goto("/?dataset=ZAS-0003"); // current smoker; BP 100, fasting sugar 85, LDL 70, HDL 45, TG 103, BMI 20
  await expect(page.getByTestId("card-cad")).toBeVisible(FIRST_LOAD);
  await page.getByTestId("case-tab-risk").click();
  const panel = page.getByTestId("risk-factors");
  await expect(panel).toContainText("not medical advice");
  await expect(panel).toContainText("not from the AI prediction");
  await expect(page.getByTestId("risk-smoking")).toContainText("Current smoker");
  await expect(panel.locator("[data-testid^=risk-]").filter({ hasNot: page.locator("p[role=note]") }))
    .toHaveCount(1);
  await expect(page.getByTestId("risk-not-assessed")).toHaveCount(0); // every input was recorded
  await expect(panel).not.toContainText(/statin|aspirin|metformin|insulin|dose/i);
});
