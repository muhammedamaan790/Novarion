// Hardening (plan §16 failure modes, §12 loading/error states, plan Days 15–17): the app fails closed and visibly.
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const FIRST_LOAD = { timeout: 30_000 };

test("backend unreachable and no offline bundle: a clear message, no predictions, the disclaimer stays", async ({ page }) => {
  await page.route("**/api/v1/**", (route) => route.abort());
  await page.route("**/demo_bundle/**", (route) => route.abort());
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("Backend unreachable or not ready", FIRST_LOAD);
  await expect(page.getByTestId("disclaimer")).toBeVisible();
  await expect(page.getByTestId("card-cad")).toHaveCount(0);
});

test("a failing prediction fails closed: no stale colours or cards, a visible error", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("tab-new").click();
  await page.getByLabel("Prefill from a dataset patient").selectOption("ZAS-0004");
  await expect(page.getByTestId("case-status")).toContainText("Prediction up to date", FIRST_LOAD);
  await expect(page.getByTestId("card-cad")).toBeVisible();
  await page.route("**/api/v1/predict", (route) =>
    route.fulfill({ status: 500, contentType: "application/json",
                    body: JSON.stringify({ error_code: "TARGET_FAILED", message: "rca failed" }) }));
  const pulse = page.getByTestId("field-pulse_rate");
  await pulse.fill(String(Number(await pulse.inputValue()) + 5));
  await expect(page.getByTestId("case-status")).toContainText("Analysis unavailable: no results shown.");
  await expect(page.getByTestId("card-cad")).toHaveCount(0); // the previous prediction is not kept for new inputs
  await expect(page.getByText("Anatomy shown in neutral grey until a complete analysis is loaded.")).toBeVisible();
});

test("rapid edits: debounced, and only the final value is predicted", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("tab-new").click();
  await page.getByLabel("Prefill from a dataset patient").selectOption("ZAS-0004");
  await expect(page.getByTestId("case-status")).toContainText("Prediction up to date", FIRST_LOAD);
  const sent: number[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/api/v1/predict")) sent.push(r.postDataJSON().inputs.pulse_rate);
  });
  const pulse = page.getByTestId("field-pulse_rate");
  for (const v of [61, 62, 63, 64, 65, 66, 67, 68]) await pulse.fill(String(v)); // faster than the 300 ms debounce
  await expect(page.getByTestId("case-status")).toContainText("Prediction up to date", FIRST_LOAD);
  await page.waitForTimeout(800);
  expect(sent.at(-1)).toBe(68);
  expect(sent.length).toBeLessThanOrEqual(2); // intermediate keystrokes never reach the server
});

test("WebGL unavailable: the 2D schematic appears and is driven by the same store", async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    // simulate a browser without WebGL (2D canvas still works)
    HTMLCanvasElement.prototype.getContext = function (type: string, ...args: unknown[]) {
      if (type.startsWith("webgl") || type === "experimental-webgl") return null;
      return (original as (...a: unknown[]) => unknown).call(this, type, ...args);
    } as typeof original;
  });
  await page.goto("/?dataset=ZAS-0003");
  await expect(page.getByTestId("fallback-2d")).toBeVisible(FIRST_LOAD);
  await expect(page.getByTestId("card-cad")).toBeVisible(FIRST_LOAD);
  await page.getByTestId("fallback-lad").click();
  await expect(page.getByTestId("card-lad")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("why-panel")).toContainText("· LAD");
});

test("WebGL context lost: an explanatory overlay, then the 3D view can be restored", async ({ page }) => {
  await page.goto("/?dataset=ZAS-0003");
  await expect(page.getByTestId("card-cad")).toBeVisible(FIRST_LOAD);
  await page.waitForTimeout(1000);
  await page.evaluate(() => {
    const canvas = document.querySelector("canvas")!;
    const gl = (canvas.getContext("webgl2") ?? canvas.getContext("webgl")) as WebGLRenderingContext;
    gl.getExtension("WEBGL_lose_context")!.loseContext();
  });
  await expect(page.getByTestId("context-lost")).toBeVisible();
  await expect(page.getByTestId("card-cad")).toBeVisible(); // panels keep working
  await page.getByTestId("restore-3d").click();
  await expect(page.getByTestId("context-lost")).toHaveCount(0);
  await expect(page.locator("canvas")).toBeVisible();
});

for (const [name, url] of [["command center", "/?dataset=ZAS-0003&target=lad"], ["model evidence", "/?page=evidence"]]) {
  test(`accessibility: no serious or critical axe violations on the ${name}`, async ({ page }) => {
    await page.goto(url);
    await page.waitForTimeout(2500);
    const results = await new AxeBuilder({ page }).exclude("canvas").analyze();
    const bad = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(bad.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`)).toEqual([]);
  });
}
