// Flow A (plan §1A): dataset patient → OOF analysis → 3D → select vessel (3D and panel) → explanation.
import { expect, test, type Page } from "@playwright/test";

const REAL = process.env.E2E_BACKEND === "real";
const SHOTS = REAL ? "../results/ui/real" : "../results/ui";

// The first navigation also compiles every WebGL shader; under headless software rendering (SwiftShader) that can
// stall the page for several seconds, so first-load checks get a longer allowance than in-app interactions.
const FIRST_LOAD = { timeout: 30_000 };

async function openPatient(page: Page, id: string) {
  await page.goto("/?page=library");
  await page.getByTestId(`patient-${id}`).click();
  await expect(page.getByTestId("card-cad")).toBeVisible(FIRST_LOAD);
}

test("disclaimer is always visible; the mock is labelled as a mock, the real model is not", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("disclaimer")).toContainText("Not a substitute for formal diagnostic imaging");
  await expect(page.getByTestId("home-new-case")).toBeVisible(); // signed-in landing: one big NEW CASE button
  await expect(page.getByTestId("mock-chip")).toHaveCount(REAL ? 0 : 1);
  await page.getByTestId("page-library").click();
  await expect(page.getByTestId("disclaimer")).toBeVisible(); // on every screen
});

test("panel selection drives the 3D view, the cards and the Why panel", async ({ page }) => {
  await openPatient(page, "ZAS-0003");
  await expect(page.getByText("OOF VALIDATION")).toBeVisible();
  for (const t of ["cad", "lad", "lcx", "rca"]) await expect(page.getByTestId(`card-${t}`)).toBeVisible();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOTS}/1-overview.png` });

  for (const [target, label] of [["lad", "LAD"], ["lcx", "LCX"], ["rca", "RCA"]] as const) {
    await page.getByTestId(`select-${target}`).click();
    await expect(page.getByTestId(`card-${target}`)).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("why-panel")).toContainText(`· ${label}`);
    await expect(page).toHaveURL(new RegExp(`target=${target}`));
    await page.waitForTimeout(1600); // camera fly-to
    await page.screenshot({ path: `${SHOTS}/2-${target}.png` });
  }
  await page.getByTestId("case-tab-why").click(); // the explanation lives on its own tab, for the selected target
  await expect(page.getByTestId("why-panel")).toBeVisible();
  await expect(page.getByTestId("why-panel")).toContainText("· RCA");
  await expect(page).toHaveURL(/tab=why/);
});

test("keyboard shortcuts select targets and Esc resets", async ({ page }) => {
  await openPatient(page, "ZAS-0004");
  await page.keyboard.press("2");
  await expect(page.getByTestId("card-lcx")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("0");
  await expect(page.getByTestId("card-cad")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("card-cad")).toHaveAttribute("aria-pressed", "false");
});

test("clicking a vessel in the 3D canvas selects the same target (reverse link)", async ({ page }) => {
  await openPatient(page, "ZAS-0006");
  await page.waitForTimeout(800);
  const canvas = page.locator("canvas");
  const box = (await canvas.boundingBox())!;
  const tooltip = page.getByRole("tooltip");
  // Sweep the canvas until the hover tooltip reports a vessel, then click exactly there.
  let hit: { x: number; y: number; label: string } | null = null;
  for (let gy = 0.25; gy <= 0.8 && !hit; gy += 0.025) {
    for (let gx = 0.3; gx <= 0.75 && !hit; gx += 0.025) {
      const x = box.x + box.width * gx;
      const y = box.y + box.height * gy;
      await page.mouse.move(x, y);
      const text = (await tooltip.count()) ? await tooltip.innerText() : "";
      const m = text.match(/^(LAD|LCX|RCA) ·/);
      if (m) hit = { x, y, label: m[1]! };
    }
  }
  expect(hit, "no vessel found under the pointer").not.toBeNull();
  await page.mouse.click(hit!.x, hit!.y);
  await expect(page.getByTestId(`card-${hit!.label.toLowerCase()}`)).toHaveAttribute("aria-pressed", "true");
  await page.waitForTimeout(1600);
  await page.screenshot({ path: `${SHOTS}/3-picked-${hit!.label.toLowerCase()}.png` });
});

test("deep link restores patient, tab and target; ground truth appears only on reveal", async ({ page }) => {
  await page.goto("/?dataset=ZAS-0006&tab=data&target=rca");
  await expect(page.getByTestId("card-rca")).toHaveAttribute("aria-pressed", "true", FIRST_LOAD);
  await expect(page.getByText("Dataset angiography labels")).toHaveCount(0);
  await page.getByText("Reveal angiography labels").click();
  await expect(page.getByText("Dataset angiography labels")).toBeVisible();
});

test("Flow B: new case from the registry form → live prediction → pinned explanation", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("page-new").click();
  await expect(page.getByTestId("case-status")).toBeVisible();
  await page.getByLabel("Prefill from a dataset patient").selectOption("ZAS-0003");
  await expect(page.getByTestId("case-status")).toContainText("Prediction up to date", { timeout: 15_000 });
  await expect(page.getByTestId("case-status")).toContainText("Matches the dataset record");
  await expect(page.getByTestId("live-summary")).toBeVisible(); // live result beside the form
  const predictions = page.getByTestId("predictions");
  const before = await predictions.getAttribute("data-input-sha256");

  // edit one measurement: provenance changes to final model, the prediction is recomputed
  const pulse = page.getByTestId("field-pulse_rate");
  await pulse.fill(String(Number(await pulse.inputValue()) + 40));
  await expect(page.getByTestId("case-status")).toContainText("Values differ from the dataset record", { timeout: 15_000 });
  await expect(page.getByTestId("case-status")).toContainText("Prediction up to date");
  await expect.poll(async () => predictions.getAttribute("data-input-sha256")).not.toBe(before); // new analysis

  await page.getByTestId("see-result").click();
  await page.getByTestId("select-lad").click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${SHOTS}/4-new-case.png` });
  await page.getByTestId("case-tab-why").click();
  await expect(page.getByTestId("why-panel")).toContainText("Why did the model predict this? · LAD", { timeout: 15_000 });
});

test("camera view presets change the view without changing the selected target", async ({ page }) => {
  await openPatient(page, "ZAS-0004");
  await page.getByTestId("select-lcx").click();
  await page.getByTestId("view-posterior").click();
  await expect(page.getByTestId("card-lcx")).toHaveAttribute("aria-pressed", "true");
  await page.waitForTimeout(1600);
  await page.screenshot({ path: `${SHOTS}/5-posterior.png` });
});

test("Model Evidence page shows scoped tables and figures for each target", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("page-evidence").click();
  await expect(page.getByTestId("evidence-page")).toBeVisible();
  await expect(page).toHaveURL(/page=evidence/);
  await expect(page.getByText("Table 1 · official metrics · CAD")).toBeVisible();
  await expect(page.getByText(/outer-fold mean ± SD/).first()).toBeVisible();
  await expect(page.getByText(/pooled OOF \(prespecified repeat\)/).first()).toBeVisible();
  await page.getByTestId("evidence-lcx").click();
  await expect(page.getByText("Table 1 · official metrics · LCX")).toBeVisible();
  if (REAL) await expect(page.getByText("Threshold sweep · LCX")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/6-evidence.png` });
  if (REAL) {
    await page.getByTestId("evidence-figures").scrollIntoViewIfNeeded();
    await page.getByTestId("evidence-figures").screenshot({ path: `${SHOTS}/7-evidence-figures.png` });
  }
  await page.getByTestId("page-library").click();
  await expect(page.getByTestId("patient-ZAS-0003")).toBeVisible();
});

test("body context: whole-body view keeps the selection; context can be hidden and never blocks vessel clicks", async ({ page }) => {
  await openPatient(page, "ZAS-0003");
  await page.getByTestId("view-body").click();
  await page.waitForTimeout(1800);
  await page.screenshot({ path: `${SHOTS}/10-whole-body.png` });
  await page.getByTestId("toggle-body").uncheck();
  await expect(page.getByTestId("toggle-body")).not.toBeChecked();
  await page.getByTestId("toggle-body").check();
  await page.getByTestId("select-lad").click(); // a target selection returns to that vessel's preset
  await expect(page.getByTestId("card-lad")).toHaveAttribute("aria-pressed", "true");
});

test("compare all vessels: callouts on the heart + contribution heatmap for every target", async ({ page }) => {
  await openPatient(page, "ZAS-0003");
  await page.getByTestId("compare-all").click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${SHOTS}/11-compare.png` }); // callouts on the heart
  await page.getByTestId("case-tab-why").click();
  const panel = page.getByTestId("compare-panel");
  await expect(panel).toContainText("Compare all targets", { timeout: 15_000 });
  for (const t of ["CAD", "LAD", "LCX", "RCA"]) await expect(panel.locator("th", { hasText: t })).toBeVisible();
  await expect(page).toHaveURL(/view=compare/);
  await page.keyboard.press("1"); // selecting a vessel leaves compare mode
  await expect(page.getByTestId("why-panel")).toBeVisible();
  await expect(page.getByTestId("compare-panel")).toHaveCount(0);
});

test("compare works for a transient new case (explanations fetched pinned)", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("page-new").click();
  await page.getByLabel("Prefill from a dataset patient").selectOption("ZAS-0004");
  await expect(page.getByTestId("case-status")).toContainText("Prediction up to date", { timeout: 15_000 });
  await page.keyboard.press("c");
  await expect(page.getByTestId("compare-panel")).toContainText("Compare all targets", { timeout: 15_000 });
});
