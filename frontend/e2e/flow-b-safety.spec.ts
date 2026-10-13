import { expect, test } from "@playwright/test";

test("a delayed prediction lands in its own workspace, never in the case on screen", async ({ page }) => {
  let release!: () => void;
  let responseReady!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const prepared = new Promise<void>((resolve) => { responseReady = resolve; });
  await page.route("**/api/v1/predict", async (route) => {
    const response = await route.fetch();
    responseReady();
    await held;
    await route.fulfill({ response }).catch(() => {});
  });

  await page.goto("/");
  await page.getByTestId("page-new").click();
  await page.getByLabel("Prefill from a dataset patient").selectOption("ZAS-0003");
  await prepared; // the new case's prediction is held in flight
  await page.getByTestId("page-library").click();
  await page.getByTestId("patient-ZAS-0004").click(); // another patient is now on screen
  await expect(page.getByTestId("card-cad")).toBeVisible({ timeout: 30_000 });
  const onScreen = await page.getByTestId("predictions").getAttribute("data-input-sha256");

  release();
  await page.waitForTimeout(700); // the held response arrives while ZAS-0004 is on screen
  await expect(page.getByRole("heading", { name: /ZAS-0004/ })).toBeVisible();
  await expect(page.getByTestId("predictions")).toHaveAttribute("data-input-sha256", onScreen!); // untouched

  await page.getByTestId("ws-tab-New case 1").click(); // ...and it is waiting in its own workspace
  await expect(page.getByTestId("live-summary")).toBeVisible();
  await expect(page.getByTestId("case-status")).toContainText("Prediction up to date");
});

test("editing an input clears old predictions while validation is pending", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("page-new").click();
  await page.getByLabel("Prefill from a dataset patient").selectOption("ZAS-0003");
  await expect(page.getByTestId("case-status")).toContainText("Prediction up to date", { timeout: 30_000 });
  await expect(page.getByTestId("live-summary")).toBeVisible();

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
    await expect(page.getByTestId("live-summary")).toHaveCount(0);
    await expect(page.getByTestId("case-status")).toContainText("1 field still required");
  } finally {
    release();
  }
});
