// OFFLINE DEMO MODE (plan §10): backend unreachable → the verified static bundle drives every dataset-patient flow.
import { expect, test } from "@playwright/test";

const FIRST_LOAD = { timeout: 30_000 };

// The static bundle is exported from a trained model bundle (scripts/export_demo_bundle.py); CI has none.
test.beforeEach(async ({ request }) => {
  const r = await request.get("/demo_bundle/index.json");
  test.skip(!r.ok() || !(r.headers()["content-type"] ?? "").includes("json"), "no exported offline demo bundle");
});

test("backend unreachable at start: static bundle, full dataset flow, no live inference", async ({ page }) => {
  await page.route("**/api/v1/**", (route) => route.abort());
  await page.goto("/?page=library");
  await expect(page.getByTestId("run-mode")).toHaveText("OFFLINE DEMO", FIRST_LOAD);
  await page.getByTestId("patient-ZAS-0003").click();
  await expect(page.getByText("OOF VALIDATION")).toBeVisible(FIRST_LOAD);
  await page.getByTestId("select-lad").click();
  await page.getByTestId("case-tab-why").click();
  await expect(page.getByTestId("why-panel")).toContainText("Why did the model predict this? · LAD");
  await page.getByTestId("case-tab-data").click();
  await page.getByText("Reveal angiography labels").click();
  await expect(page.getByText("Dataset angiography labels")).toBeVisible();
  await page.getByTestId("case-tab-result").click();
  await page.getByTestId("save-case").click(); // cases live in the browser, so saving works offline
  await expect(page.getByTestId("case-id")).toHaveText(/^CASE-\d{4}-\d{4}$/);
  await page.getByTestId("page-new").click();
  await expect(page.getByTestId("new-case-offline")).toContainText("New cases need the live model");
  await page.getByTestId("page-evidence").click();
  await page.getByTestId("evidence-section-performance").click();
  await expect(page.getByText("Table 1 · official metrics · CAD")).toBeVisible();
});

test("a tampered static bundle is refused (integrity check)", async ({ page }) => {
  await page.route("**/api/v1/**", (route) => route.abort());
  await page.route("**/demo_bundle/index.json", async (route) => {
    const doc = await (await route.fetch()).json();
    doc.index.patients[0].age = 99; // any change breaks demo_bundle_sha256
    await route.fulfill({ json: doc });
  });
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("Backend unreachable", FIRST_LOAD);
  await expect(page.getByTestId("run-mode")).toHaveCount(0); // never claims offline mode on a refused bundle
});

test("backend dies mid-session: 'Switch to offline demo' recovers the dataset flow", async ({ page }) => {
  await page.goto("/?page=library");
  await expect(page.getByTestId("patient-ZAS-0004")).toBeVisible(FIRST_LOAD);
  await expect(page.getByTestId("run-mode")).toHaveCount(0); // live: no mode chip
  await page.route("**/api/v1/**", (route) => route.abort());
  await page.getByTestId("patient-ZAS-0004").click();
  await page.getByTestId("switch-offline").first().click();
  await expect(page.getByTestId("run-mode")).toHaveText("OFFLINE DEMO");
  await expect(page.getByTestId("card-cad")).toBeVisible(FIRST_LOAD); // the open patient reloads from the bundle
});

test("audit R03: a patient file that differs from its recorded hash is refused, the others still load", async ({ page }) => {
  await page.route("**/api/v1/**", (route) => route.abort());
  await page.route("**/demo_bundle/patients/ZAS-0003.json", async (route) => {
    const doc = await (await route.fetch()).json();
    doc.bundle.targets.cad.probability = 0.01; // altered prediction; the index is untouched
    await route.fulfill({ json: doc });
  });
  await page.goto("/?page=library");
  await expect(page.getByTestId("run-mode")).toHaveText("OFFLINE DEMO", FIRST_LOAD);
  await page.getByTestId("patient-ZAS-0003").click();
  await expect(page.getByRole("alert")).toContainText("Analysis unavailable", FIRST_LOAD);
  await expect(page.getByTestId("card-cad")).toHaveCount(0); // never shown as a normal result
  await page.getByTestId("page-library").click();
  await page.getByTestId("patient-ZAS-0004").click();
  await expect(page.getByTestId("card-cad")).toBeVisible(FIRST_LOAD); // untampered files still verify
});

test("audit R03: a static file that differs from its recorded hash is refused", async ({ page }) => {
  await page.route("**/api/v1/**", (route) => route.abort());
  await page.route("**/demo_bundle/meta.json", async (route) => {
    const doc = await (await route.fetch()).json();
    doc.model_version = "9.9.9";
    await route.fulfill({ json: doc });
  });
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("Backend unreachable or not ready", FIRST_LOAD);
  await expect(page.getByTestId("home-new-case")).toHaveCount(0);
});
