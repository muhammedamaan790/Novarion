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
  await page.getByTestId("page-new").click();
  await page.getByLabel("Prefill from a dataset patient").selectOption("ZAS-0004");
  await expect(page.getByTestId("case-status")).toContainText("Prediction up to date", FIRST_LOAD);
  await expect(page.getByTestId("live-summary")).toBeVisible();
  await page.route("**/api/v1/predict", (route) =>
    route.fulfill({ status: 500, contentType: "application/json",
                    body: JSON.stringify({ error_code: "TARGET_FAILED", message: "rca failed" }) }));
  const pulse = page.getByTestId("field-pulse_rate");
  await pulse.fill(String(Number(await pulse.inputValue()) + 5));
  await expect(page.getByTestId("case-status")).toContainText("Analysis unavailable: no results shown.");
  await expect(page.getByTestId("card-cad")).toHaveCount(0); // the previous prediction is not kept for new inputs
  await expect(page.getByTestId("live-summary")).toHaveCount(0);
  await page.getByTestId("case-tab-result").click();
  await expect(page.getByText("Anatomy shown in neutral grey until a complete analysis is loaded.")).toBeVisible();
});

test("rapid edits: debounced, and only the final value is predicted", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("page-new").click();
  await page.getByLabel("Prefill from a dataset patient").selectOption("ZAS-0004");
  await expect(page.getByTestId("case-status")).toContainText("Prediction up to date", FIRST_LOAD);
  const sent: number[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/api/v1/predict")) sent.push(r.postDataJSON().inputs.pulse_rate);
  });
  // eight edits inside ONE browser task: genuinely faster than the 300 ms debounce on any machine (slow CI included)
  await page.getByTestId("field-pulse_rate").evaluate((el: HTMLInputElement) => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    for (const v of [61, 62, 63, 64, 65, 66, 67, 68]) {
      setValue.call(el, String(v));
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
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
  await expect(page.locator("canvas")).toBeVisible(FIRST_LOAD); // the 3D view loads on demand
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

test("a 3D view whose drawing was discarded (background tab) is redrawn when the tab is shown again", async ({ page }) => {
  await page.goto("/?dataset=ZAS-0003");
  await expect(page.getByTestId("card-cad")).toBeVisible(FIRST_LOAD);
  const canvas = page.locator("canvas");
  await expect(canvas).toBeVisible(FIRST_LOAD);
  // share of the canvas that is neither the scene background nor white: the heart (decoded in the page, no image library)
  const drawn = async () => page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const bg = Math.abs(d[i] - 0xf4) + Math.abs(d[i + 1] - 0xf5) + Math.abs(d[i + 2] - 0xf7) <= 30;
      if (!bg && !(d[i] > 250 && d[i + 1] > 250 && d[i + 2] > 250)) n++;
    }
    return n / (c.width * c.height);
  }, (await canvas.screenshot()).toString("base64"));
  await expect.poll(drawn, { timeout: 10_000 }).toBeGreaterThan(0.15);
  await page.waitForTimeout(2_500); // the camera has settled: nothing redraws on its own any more
  await page.evaluate(() => { // what the browser does to a background tab's canvas under memory pressure
    const c = document.querySelector("canvas")!;
    const gl = (c.getContext("webgl2") ?? c.getContext("webgl")) as WebGLRenderingContext;
    gl.clearColor(1, 1, 1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  });
  await expect.poll(drawn).toBeLessThan(0.05); // blank, only the HTML labels remain
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect.poll(drawn, { timeout: 5_000 }).toBeGreaterThan(0.15); // the heart is back
});

test("accessibility: the 2D fallback (no WebGL, e.g. a GPU-less CI runner) has no serious or critical axe violations",
  async ({ page }) => {
    await page.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type: string, ...args: unknown[]) {
        if (type.startsWith("webgl") || type === "experimental-webgl") return null;
        return (original as (...a: unknown[]) => unknown).call(this, type, ...args) as never;
      } as never;
    });
    await page.goto("/?dataset=ZAS-0003&target=lad");
    await expect(page.getByTestId("card-cad")).toBeVisible({ timeout: 30_000 });
    const results = await new AxeBuilder({ page }).exclude("canvas").analyze();
    const bad = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(bad.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`)).toEqual([]);
  });

for (const [name, url] of [["home page", "/"], ["dataset library", "/?page=library"],
  ["case result", "/?dataset=ZAS-0003&target=lad"], ["case why tab", "/?dataset=ZAS-0003&tab=why&target=lad"],
  ["case patient data tab", "/?dataset=ZAS-0003&tab=data"], ["case risk factors tab", "/?dataset=ZAS-0003&tab=risk"],
  ["model evidence", "/?page=evidence"]]) {
  test(`accessibility: no serious or critical axe violations on the ${name}`, async ({ page }) => {
    await page.goto(url);
    await page.waitForTimeout(2500);
    const results = await new AxeBuilder({ page }).exclude("canvas").analyze();
    const bad = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(bad.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`)).toEqual([]);
  });
}

test("privacy: every request stays same-origin (no third-party calls, no service worker)", async ({ page, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const foreign: string[] = [];
  page.on("request", (r) => {
    const url = r.url();
    if (url.startsWith("data:") || url.startsWith("blob:")) return;
    if (new URL(url).origin !== origin) foreign.push(url);
  });
  await page.goto("/?dataset=ZAS-0003&target=lad");
  await expect(page.getByTestId("why-panel")).toContainText("· LAD", FIRST_LOAD);
  await page.getByTestId("page-new").click();
  await page.getByLabel("Prefill from a dataset patient").selectOption("ZAS-0004");
  await expect(page.getByTestId("case-status")).toContainText("Prediction up to date", FIRST_LOAD);
  await page.getByTestId("page-evidence").click();
  await page.getByTestId("page-models").click();
  await expect(page.getByTestId("model-center")).toBeVisible(FIRST_LOAD);
  expect(foreign).toEqual([]);
  expect(await page.evaluate(async () => (await navigator.serviceWorker?.getRegistrations())?.length ?? 0)).toBe(0);
});

test("no page lets the window scroll past the disclaimer: every page scrolls inside the app", async ({ page }) => {
  // Model Center did: its charts' absolutely positioned screen-reader tables had no positioned ancestor in the page.
  for (const url of ["/", "/?page=library", "/?page=cases", "/?page=anatomy", "/?page=evidence", "/?page=models",
    "/?dataset=ZAS-0003", "/?dataset=ZAS-0003&tab=why", "/?dataset=ZAS-0003&tab=risk"]) {
    await page.goto(url);
    await expect(page.getByTestId("disclaimer")).toBeVisible(FIRST_LOAD);
    await page.waitForTimeout(1500); // charts and the 3D view settle
    const overflow = await page.evaluate(() => document.scrollingElement!.scrollHeight - window.innerHeight);
    expect(overflow, url).toBeLessThanOrEqual(1);
  }
});
