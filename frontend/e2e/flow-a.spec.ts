// Flow A (plan §1A): dataset patient → OOF analysis → 3D → select vessel (3D and panel) → explanation.
import { expect, test, type Page } from "@playwright/test";

const REAL = process.env.E2E_BACKEND === "real";
const SHOTS = REAL ? "../results/ui/real" : "../results/ui";

async function openPatient(page: Page, id: string) {
  await page.goto("/");
  await page.getByTestId(`patient-${id}`).click();
  await expect(page.getByTestId("card-cad")).toBeVisible();
}

test("disclaimer is always visible; the mock is labelled as a mock, the real model is not", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("disclaimer")).toContainText("Not a substitute for formal diagnostic imaging");
  await expect(page.getByText(/READY/)).toBeVisible();
  await expect(page.getByTestId("mock-chip")).toHaveCount(REAL ? 0 : 1);
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
});

test("keyboard shortcuts select targets and Esc resets", async ({ page }) => {
  await openPatient(page, "ZAS-0004");
  await page.keyboard.press("2");
  await expect(page.getByTestId("card-lcx")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("0");
  await expect(page.getByTestId("card-cad")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("why-panel")).toHaveCount(0);
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

test("deep link restores patient and target; ground truth appears only on reveal", async ({ page }) => {
  await page.goto("/?dataset=ZAS-0006&target=rca");
  await expect(page.getByTestId("card-rca")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Dataset angiography labels")).toHaveCount(0);
  await page.getByText("Reveal angiography labels").click();
  await expect(page.getByText("Dataset angiography labels")).toBeVisible();
});

test("Flow B: new case from the registry form → live prediction → pinned explanation", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("tab-new").click();
  await expect(page.getByTestId("case-status")).toBeVisible();
  await page.getByLabel("Prefill from a dataset patient").selectOption("ZAS-0003");
  await expect(page.getByTestId("case-status")).toContainText("Prediction up to date", { timeout: 15_000 });
  await expect(page.getByTestId("case-status")).toContainText("Matches the dataset record");
  await expect(page.getByTestId("card-lad")).toBeVisible();
  const predictions = page.getByTestId("predictions");
  const before = await predictions.getAttribute("data-input-sha256");

  // edit one measurement: provenance changes to final model, the prediction is recomputed
  const pulse = page.getByTestId("field-pulse_rate");
  await pulse.fill(String(Number(await pulse.inputValue()) + 40));
  await expect(page.getByTestId("case-status")).toContainText("Values differ from the dataset record", { timeout: 15_000 });
  await expect(page.getByTestId("case-status")).toContainText("Prediction up to date");
  await expect.poll(async () => predictions.getAttribute("data-input-sha256")).not.toBe(before); // new analysis

  await page.getByTestId("select-lad").click();
  await expect(page.getByTestId("why-panel")).toContainText("Why did the model predict this? · LAD", { timeout: 15_000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${SHOTS}/4-new-case.png` });
});

test("camera view presets change the view without changing the selected target", async ({ page }) => {
  await openPatient(page, "ZAS-0004");
  await page.getByTestId("select-lcx").click();
  await page.getByTestId("view-posterior").click();
  await expect(page.getByTestId("card-lcx")).toHaveAttribute("aria-pressed", "true");
  await page.waitForTimeout(1600);
  await page.screenshot({ path: `${SHOTS}/5-posterior.png` });
});
