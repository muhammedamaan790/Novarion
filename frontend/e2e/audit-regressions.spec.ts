import { expect, test } from "@playwright/test";

test("the most recently selected prefill wins even if the first response arrives last", async ({ page }) => {
  let release!: () => void;
  let prepared!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { prepared = resolve; });
  await page.route("**/api/v1/patients/ZAS-0003", async (route) => {
    const response = await route.fetch();
    prepared();
    await held;
    await route.fulfill({ response }).catch(() => {});
  });
  const expected = (await (await page.request.get("/api/v1/patients/ZAS-0004")).json()).canonical_inputs;
  await page.goto("/");
  await page.getByTestId("page-new").click();
  await page.getByLabel("Prefill from a dataset patient").selectOption("ZAS-0003");
  await started;
  await page.getByLabel("Prefill from a dataset patient").selectOption("ZAS-0004");
  await expect(page.getByTestId("case-status")).toContainText("Prediction up to date");
  release();
  await page.waitForTimeout(700);
  await expect(page.getByTestId("field-weight")).toHaveValue(String(expected.weight));
  await expect(page.getByLabel("Prefill from a dataset patient")).toHaveValue("ZAS-0004");
});

test("a failed prefill clears previous results and explains the failure", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("page-new").click();
  const prefill = page.getByLabel("Prefill from a dataset patient");
  await prefill.selectOption("ZAS-0003");
  await expect(page.getByTestId("live-summary")).toBeVisible();
  await page.route("**/api/v1/patients/ZAS-0004", (route) => route.fulfill({ status: 503, json: { message: "Unavailable" } }));
  await prefill.selectOption("ZAS-0004");
  await expect(page.getByTestId("case-status")).toContainText("Could not load the selected patient");
  await expect(page.getByTestId("predictions")).toHaveCount(0);
  await expect(page.getByTestId("live-summary")).toHaveCount(0);
});

test("select inputs consume keyboard keys without changing the prediction target", async ({ page }) => {
  await page.goto("/?target=rca");
  await page.getByTestId("page-new").click();
  await page.getByTestId("case-tab-result").click();
  await page.getByTestId("select-rca").click();
  await page.getByTestId("case-tab-data").click();
  await page.getByTestId("field-sex").focus();
  await page.keyboard.press("2");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("select-rca")).toHaveAttribute("aria-pressed", "true");
});

test("an invalid successful API response becomes a visible error", async ({ page }) => {
  await page.route("**/api/v1/meta", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<html>proxy failure</html>" }));
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("Backend unreachable or not ready", { timeout: 15000 });
  await expect(page.getByTestId("predictions")).toHaveCount(0);
});

test("a missing 3D model preserves the patient and prediction panels", async ({ page }) => {
  await page.route("**/models/heart.glb", (route) => route.fulfill({ status: 404, body: "Missing" }));
  await page.goto("/?dataset=ZAS-0003&target=lad");
  await expect(page.getByText("3D view unavailable.")).toBeVisible();
  await expect(page.getByTestId("card-lad")).toBeVisible();
  await page.getByTestId("case-tab-why").click();
  await expect(page.getByTestId("why-panel")).toBeVisible();
});

test("mobile layout fits the viewport and the input form remains usable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByTestId("page-new").click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await expect(page.getByTestId("field-age")).toBeVisible();
  const formHeight = await page.locator("form").evaluate((el) => el.getBoundingClientRect().height);
  expect(formHeight).toBeGreaterThan(200);
});

test("a partial prediction response never commits three targets", async ({ page }) => {
  await page.route("**/api/v1/predict", async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    delete payload.targets.rca;
    await route.fulfill({ response, json: payload });
  });
  await page.goto("/");
  await page.getByTestId("page-new").click();
  await page.getByLabel("Prefill from a dataset patient").selectOption("ZAS-0003");
  await expect(page.getByTestId("case-status")).toContainText("Analysis unavailable");
  await expect(page.getByTestId("predictions")).toHaveCount(0);
});

test("manual edits cancel a pending prefill rather than being overwritten", async ({ page }) => {
  let release!: () => void;
  let prepared!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { prepared = resolve; });
  await page.route("**/api/v1/patients/ZAS-0003", async (route) => {
    const response = await route.fetch();
    prepared();
    await held;
    await route.fulfill({ response }).catch(() => {});
  });
  await page.goto("/");
  await page.getByTestId("page-new").click();
  await page.getByLabel("Prefill from a dataset patient").selectOption("ZAS-0003");
  await started;
  await page.getByTestId("field-age").fill("71");
  release();
  await page.waitForTimeout(700);
  await expect(page.getByTestId("field-age")).toHaveValue("71");
  await expect(page.getByTestId("case-status")).toContainText("still required");
  await expect(page.getByTestId("predictions")).toHaveCount(0);
});
