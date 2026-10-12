import { expect, test } from "@playwright/test";

test("leaving a new case discards its delayed prediction", async ({ page }) => {
  let release!: () => void;
  let responseReady!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const prepared = new Promise<void>((resolve) => { responseReady = resolve; });
  await page.route("**/api/v1/predict", async (route) => {
    const response = await route.fetch();
    responseReady();
    await held;
    await route.fulfill({ response }).catch(() => {}); // cancellation is expected after leaving the form
  });

  await page.goto("/");
  await page.getByTestId("tab-new").click();
  await page.getByLabel("Prefill from a dataset patient").selectOption("ZAS-0003");
  await prepared;
  await page.getByTestId("tab-dataset").click();
  const neutral = page.getByText("Anatomy shown in neutral grey until a complete analysis is loaded.");
  await expect(neutral).toBeVisible();
  release();
  await page.waitForTimeout(700); // allow the held response to try to commit after the tab switch
  await expect(neutral).toBeVisible();
  await expect(page.getByTestId("predictions")).toHaveCount(0);
});

test("editing an input clears old predictions while validation is pending", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("tab-new").click();
  await page.getByLabel("Prefill from a dataset patient").selectOption("ZAS-0003");
  await expect(page.getByTestId("case-status")).toContainText("Prediction up to date");
  await expect(page.getByTestId("predictions")).toBeVisible();

  let release!: () => void;
  let requestSeen!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { requestSeen = resolve; });
  await page.route("**/api/v1/validate", async (route) => {
    requestSeen();
    await held;
    await route.continue().catch(() => {});
  });
  await page.getByTestId("field-age").fill("");
  await started;
  try {
    await expect(page.getByTestId("predictions")).toHaveCount(0);
    await expect(page.getByText("Anatomy shown in neutral grey until a complete analysis is loaded.")).toBeVisible();
    await expect(page.getByTestId("case-status")).toContainText("1 field still required");
  } finally {
    release();
  }
});
