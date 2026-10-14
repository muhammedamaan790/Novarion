// New case form: value problems appear in a dismissible panel at the bottom right, not as a list inside the form;
// missing values are not listed there (the form marks them and counts them, with a button to the first one).
import { expect, test } from "@playwright/test";

test("value problems show in a bottom-right panel; missing values are counted, not listed; clickables show a hand", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("page-new").click();
  await expect(page.getByTestId("case-status")).toContainText("still required", { timeout: 30_000 });
  await expect(page.getByTestId("case-issues")).toHaveCount(0); // a blank form lists nothing

  await page.getByTestId("go-to-required").click();
  await expect(page.locator("input:focus, select:focus")).toHaveAttribute("data-testid", "field-age");

  await page.getByLabel("Prefill from a dataset patient").selectOption("ZAS-0003");
  await expect(page.getByTestId("case-status")).toContainText("Prediction up to date", { timeout: 30_000 });
  await page.getByTestId("field-ejection_fraction").fill("120"); // outside the hard range 5-90
  const panel = page.getByTestId("case-issues");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Ejection fraction");
  await expect(panel).not.toContainText("explicit UNKNOWN");
  const box = (await panel.boundingBox())!;
  expect(box.x + box.width).toBeGreaterThan(1440 - 40); // pinned to the right edge...
  expect(box.y + box.height).toBeGreaterThan(900 - 120); // ...near the bottom, clear of the case tabs and Save

  await page.getByTestId("case-issues-dismiss").click();
  await expect(panel).toHaveCount(0);
  await page.getByTestId("field-ejection_fraction").fill("40"); // fixed: nothing comes back
  await expect(page.getByTestId("case-status")).toContainText("Prediction up to date", { timeout: 30_000 });
  await expect(panel).toHaveCount(0);

  const cursor = (testId: string) => page.getByTestId(testId).evaluate((n) => getComputedStyle(n).cursor);
  expect(await cursor("page-library")).toBe("pointer");
  expect(await cursor("field-sex")).toBe("pointer"); // a select
});
