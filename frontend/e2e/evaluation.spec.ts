import { expect, test, type Page } from "@playwright/test";

async function fixture(page: Page) {
  return (await page.request.get("/api/v1/evaluation")).json();
}

test("evaluation displays all four API targets, synthetic labels, fold dispersion and NA baselines", async ({ page }) => {
  const source = await fixture(page);
  await page.goto("/");
  await page.getByTestId("nav-evaluation").click();
  await expect(page.getByTestId("disclaimer")).toBeVisible();
  await expect(page.getByTestId("evaluation-mock")).toContainText("NOT MODEL PERFORMANCE");
  const table = page.getByTestId("evaluation-performance");
  for (const target of ["cad", "lad", "lcx", "rca"]) {
    await expect(page.getByTestId(`evaluation-target-${target}`)).toBeVisible();
    const metrics = source.table1.find((row: { target: string; model: string }) => row.target === target && row.model === "mock_model").metrics;
    const row = table.getByRole("row", { name: new RegExp(`^${target.toUpperCase()} `) });
    await expect(row).toContainText(`${metrics.roc_auc.mean.toFixed(3)} ± ${metrics.roc_auc.sd.toFixed(3)}`);
    await expect(row).toContainText(`${(metrics.accuracy.mean * 100).toFixed(1)}% ± ${(metrics.accuracy.sd * 100).toFixed(1)} pp`);
  }
  const negative = page.getByTestId("evaluation-baselines").getByRole("row", { name: /^Always negative / });
  await expect(negative.getByRole("cell").nth(2)).toContainText("NA");
  await expect(negative.getByRole("cell").nth(2)).toContainText("0 defined · 5 undefined folds");
  await expect(page.getByRole("heading", { name: "CAD · Calibration" }).locator("..")).toContainText("Not supplied");
  await expect(page.getByText(/This table applies thresholds only/)).toBeVisible();
});

test("target selection updates coverage and calibration from API fields without changing the case target", async ({ page }) => {
  const source = await fixture(page);
  source.table1.find((row: { target: string; model: string }) => row.target === "lcx" && row.model === "mock_model").metrics.cal_slope = {
    mean: 0.812, sd: 0.043, n_defined: 4, n_na: 1,
  };
  const regions = source.table2.find((row: { target: string }) => row.target === "lcx");
  Object.assign(regions, { pct_high_positive: 0, pct_high_negative: 0, pct_low_confidence: 1, ppv: null,
    ppv_ci: null, npv: null, npv_ci: null, accuracy_high_confidence: null, fn_high_negative: 0, fp_high_positive: 0 });
  await page.route("**/api/v1/evaluation", (route) => route.fulfill({ json: source, headers: { "X-Novarion-Mock": "1" } }));
  await page.goto("/?view=evaluation&dataset=ZAS-0003&target=rca");
  await page.getByTestId("evaluation-target-lcx").click();
  const coverage = page.getByRole("heading", { name: "LCX · Confidence coverage" }).locator("..");
  await expect(coverage).toContainText("100.0%");
  await expect(coverage).toContainText("0.0%");
  await expect(page.getByText("No defined estimate")).toHaveCount(2);
  const calibration = page.getByRole("heading", { name: "LCX · Calibration" }).locator("..");
  await expect(calibration).toContainText("0.812 ± 0.043");
  await expect(calibration).toContainText("4 defined · 1 undefined folds");
  await page.keyboard.press("1");
  await page.getByTestId("nav-review").click();
  await expect(page.getByTestId("card-rca")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("canvas")).toBeVisible();
});

test("an API failure exposes Retry and a successful retry renders metrics", async ({ page }) => {
  let fail = true;
  await page.route("**/api/v1/evaluation", (route) => fail
    ? route.fulfill({ status: 503, json: { message: "Evaluation temporarily unavailable" } }) : route.continue());
  await page.goto("/?view=evaluation");
  await expect(page.getByRole("alert")).toContainText("Evaluation unavailable. No metrics shown.");
  await expect(page.getByTestId("evaluation-performance")).toHaveCount(0);
  fail = false;
  await page.getByRole("button", { name: "Retry evaluation" }).click();
  await expect(page.getByTestId("evaluation-performance")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("failed refresh hides previously successful cached metrics", async ({ page }) => {
  await page.goto("/?view=evaluation");
  await expect(page.getByTestId("evaluation-performance")).toBeVisible();
  await page.route("**/api/v1/evaluation", (route) => route.fulfill({ status: 503, json: { message: "Unavailable" } }));
  await page.getByRole("button", { name: "Refresh evaluation" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByTestId("evaluation-performance")).toHaveCount(0);
});

for (const defect of ["version mismatch", "missing target", "invalid coverage", "invalid metric", "mixed model identities"] as const) {
  test(`${defect} fails closed instead of displaying misleading metrics`, async ({ page }) => {
    const source = await fixture(page);
    if (defect === "version mismatch") source.model_version = "9.9.9";
    if (defect === "missing target") source.table1 = source.table1.filter((row: { target: string }) => row.target !== "rca");
    if (defect === "invalid coverage") source.table2[0].pct_low_confidence = 0;
    if (defect === "invalid metric") source.table1[0].metrics.roc_auc.mean = 2;
    if (defect === "mixed model identities") source.table1.push({ ...source.table1[0], model: "nested_cv_selected" });
    await page.route("**/api/v1/evaluation", (route) => route.fulfill({ json: source, headers: { "X-Novarion-Mock": "1" } }));
    await page.goto("/?view=evaluation");
    await expect(page.getByRole("alert")).toContainText("No metrics shown.");
    await expect(page.getByTestId("evaluation-performance")).toHaveCount(0);
  });
}

test("a controlled non-mock response uses the real bundle row identity without a synthetic badge", async ({ page }) => {
  // Contract compatibility only: these fixture values are not evidence from trained weights.
  const source = await fixture(page);
  const meta = await (await page.request.get("/api/v1/meta")).json();
  source.model_version = meta.model_version = "0.1.1";
  for (const row of source.table1) if (row.model === "mock_model") row.model = "nested_cv_selected";
  await page.route("**/api/v1/meta", (route) => route.fulfill({ json: meta }));
  await page.route("**/api/v1/evaluation", (route) => route.fulfill({ json: source }));
  await page.goto("/?view=evaluation");
  await expect(page.getByTestId("evaluation-performance")).toBeVisible();
  await expect(page.getByTestId("evaluation-mock")).toHaveCount(0);
  await expect(page.getByTestId("evaluation-baselines").getByRole("rowheader", { name: "Selected model", exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("switching views preserves the new case and its committed analysis", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("tab-new").click();
  await page.getByLabel("Prefill from a dataset patient").selectOption("ZAS-0003");
  await expect(page.getByTestId("case-status")).toContainText("Prediction up to date");
  const value = await page.getByTestId("field-weight").inputValue();
  const predictions = await page.getByTestId("predictions").innerText();
  await page.getByTestId("nav-evaluation").click();
  await expect(page.getByTestId("evaluation-performance")).toBeVisible();
  await expect(page.locator("canvas")).toHaveCount(0);
  await page.getByTestId("nav-review").click();
  await expect(page.getByTestId("field-weight")).toHaveValue(value);
  await expect(page.getByTestId("predictions")).toHaveText(predictions);
  await expect(page.getByTestId("case-status")).toContainText("Prediction up to date");
  await expect(page.locator("canvas")).toBeVisible();
});

test("evaluation deep link survives reload and preserves dataset selection", async ({ page }) => {
  await page.goto("/?dataset=ZAS-0006&target=lad");
  await expect(page.getByTestId("card-lad")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("nav-evaluation").click();
  await expect(page).toHaveURL(/view=evaluation/);
  await page.reload();
  await expect(page.getByTestId("evaluation-performance")).toBeVisible();
  await expect(page).toHaveURL(/dataset=ZAS-0006.*target=lad/);
  await page.getByTestId("nav-review").click();
  await expect(page.getByTestId("card-lad")).toHaveAttribute("aria-pressed", "true");
});

test("mobile evaluation fits the page while tables scroll within their panels", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?view=evaluation");
  await expect(page.getByTestId("evaluation-performance")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const scrollRegion = page.getByRole("region", { name: "Performance table, scroll horizontally on small screens" });
  expect(await scrollRegion.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  await page.getByTestId("evaluation-target-rca").click();
  await expect(page.getByRole("heading", { name: "RCA · Confidence coverage" })).toBeVisible();
  await page.getByTestId("nav-review").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("tab-dataset")).toBeVisible();
});
