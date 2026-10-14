// The landing hero's "Explore the coronary arteries" (D-036): controls, picking, tour ownership, deliberate zoom that
// never takes page scrolling, reduced motion and keyboard, failure fallbacks (no WebGL, model error, context loss),
// touch screens that opt in to 3D, and isolation from a signed-in workspace. The page is public: auth is stubbed
// signed out, as in auth.spec.ts.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const SIGNED_OUT = { auth_required: true, accounts_configured: true, user: null };

async function openLanding(page: Page, { signInPassword }: { signInPassword?: string } = {}) {
  let user: string | null = null;
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({ json: { ...SIGNED_OUT, user } }));
  await page.route("**/api/v1/auth/login", async (route) => {
    const body = route.request().postDataJSON() as { username: string; password: string };
    if (body.password !== signInPassword) return route.fulfill({ status: 401, json: { error_code: "INVALID_CREDENTIALS", message: "Wrong", details: {} } });
    user = body.username;
    return route.fulfill({ json: { ...SIGNED_OUT, user } });
  });
  await page.goto("/");
  await expect(page.getByTestId("landing-heart")).toBeVisible();
}

const caption = (page: Page) => page.getByTestId("landing-heart-caption");
const ready3d = (page: Page) => expect(page.getByTestId("landing-heart-reset")).toBeVisible({ timeout: 30_000 });

test("desktop: the 3D heart is ready, the tour runs once and stops for the visitor; controls, labels and reset work", async ({ page }) => {
  await openLanding(page);
  await ready3d(page);
  await expect(page.getByTestId("landing-heart-hint")).toHaveText("Drag to rotate · Select an artery");
  await expect(caption(page)).toHaveText(/^Whole heart/);
  await expect(page.getByTestId("landing-heart-tour")).toHaveText(/Pause tour/); // one automatic pass, visibly stoppable
  await expect(caption(page)).toHaveText(/^LAD/, { timeout: 10_000 });
  // choosing a view stops the tour, and the tour never takes the view back
  await page.getByTestId("landing-heart-view-rca").click();
  await expect(page.getByTestId("landing-heart-tour")).toHaveText(/Guided tour/);
  await expect(page.getByTestId("landing-heart-view-rca")).toHaveAttribute("aria-pressed", "true");
  await expect(caption(page)).toHaveText(/^RCA · Right coronary artery/);
  await page.waitForTimeout(4_500);
  await expect(caption(page)).toHaveText(/^RCA/);
  // a label on the heart selects too; Reset returns to the whole heart
  await page.getByTestId("landing-heart-label-lcx").click();
  await expect(caption(page)).toHaveText(/^LCX/);
  await page.getByTestId("landing-heart-reset").click();
  await expect(caption(page)).toHaveText(/^Whole heart/);
  // Play resumes; a drag on the heart pauses it at once
  await page.getByTestId("landing-heart-tour").click();
  await expect(page.getByTestId("landing-heart-tour")).toHaveText(/Pause tour/);
  const box = (await page.getByTestId("landing-heart-3d").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId("landing-heart-tour")).toHaveText(/Guided tour/);
  await expect(page.getByText("does not locate a lesion")).toBeVisible();
  await expect(page.getByTestId("landing-heart-badge")).toHaveText("Reference anatomy · Educational demonstration · Not patient-specific");
});

test("desktop: a plain wheel scrolls the page over the heart; Ctrl + wheel zooms instead", async ({ page }) => {
  await openLanding(page);
  await ready3d(page);
  await page.getByTestId("landing-heart-tour").click(); // pause, so nothing else moves the camera
  const landing = page.getByTestId("landing");
  const box = (await page.getByTestId("landing-heart-3d").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -300);
  await page.keyboard.up("Control");
  await page.waitForTimeout(300);
  expect(await landing.evaluate((n) => n.scrollTop)).toBe(0); // Ctrl + wheel stayed with the heart
  await page.mouse.wheel(0, 400);
  await expect.poll(() => landing.evaluate((n) => n.scrollTop)).toBeGreaterThan(0);
});

test("the tour waits while the heart is scrolled off screen", async ({ page }) => {
  await openLanding(page);
  await ready3d(page);
  await expect(caption(page)).toHaveText(/^LAD/, { timeout: 10_000 });
  await page.getByTestId("landing").evaluate((n) => n.scrollTo(0, n.scrollHeight));
  await page.waitForTimeout(5_000); // more than one tour step
  await page.getByTestId("landing").evaluate((n) => n.scrollTo(0, 0));
  await expect(caption(page)).toHaveText(/^LAD/); // no step was taken off screen
});

test("keyboard only, reduced motion: no tour starts by itself; every view and reset work from the keyboard", async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage();
  await openLanding(page);
  await ready3d(page);
  await page.waitForTimeout(4_500);
  await expect(caption(page)).toHaveText(/^Whole heart/);
  await expect(page.getByTestId("landing-heart-tour")).toHaveText(/Guided tour/);
  await page.getByTestId("landing-heart-view-whole").focus();
  for (const [key, name] of [["lad", "LAD"], ["lcx", "LCX"], ["rca", "RCA"]] as const) {
    await page.keyboard.press("Tab");
    await expect(page.getByTestId(`landing-heart-view-${key}`)).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(caption(page)).toHaveText(new RegExp(`^${name}`));
  }
  await page.getByTestId("landing-heart-reset").focus();
  await page.keyboard.press("Enter");
  await expect(caption(page)).toHaveText(/^Whole heart/);
  await context.close();
});

test("no WebGL: the image, the attribution and every artery's information remain", async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type: string, ...args: unknown[]) {
      if (type.startsWith("webgl") || type === "experimental-webgl") return null;
      return (original as (...a: unknown[]) => unknown).call(this, type, ...args);
    } as typeof original;
  });
  await openLanding(page);
  await expect(page.locator("img[src='/landing/heart.webp']")).toHaveJSProperty("complete", true);
  await page.waitForTimeout(1_500);
  await expect(page.getByTestId("landing-heart-3d")).toHaveCount(0);
  await expect(page.getByTestId("landing-heart-explore")).toHaveCount(0);
  await page.getByTestId("landing-heart-view-lcx").click();
  await expect(caption(page)).toHaveText(/^LCX · Left circumflex artery/);
  await expect(page.getByText("BodyParts3D (CC BY 4.0)")).toBeVisible();
});

test("a model that fails to load, or a lost WebGL context, falls back to the image without a blank card", async ({ page }) => {
  await page.route("**/models/heart.glb", (route) => route.fulfill({ status: 500, body: "" }));
  await openLanding(page);
  await expect(page.getByTestId("landing-heart-failed")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("landing-heart-3d")).toHaveCount(0);
  await expect(page.locator("img[src='/landing/heart.webp']")).toBeVisible();
  await page.getByTestId("landing-heart-view-rca").click();
  await expect(caption(page)).toHaveText(/^RCA/);

  await page.unroute("**/models/heart.glb");
  await page.reload();
  await ready3d(page);
  await page.getByTestId("landing-heart-3d").locator("canvas").evaluate((c: HTMLCanvasElement) => {
    (c.getContext("webgl2") ?? c.getContext("webgl"))?.getExtension("WEBGL_lose_context")?.loseContext();
  });
  await expect(page.getByTestId("landing-heart-failed")).toBeVisible();
  await expect(page.getByTestId("landing-heart-3d")).toHaveCount(0);
});

test("phone: the image and information first; 3D only on request, and Done gives the page back", async ({ browser }) => {
  for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
    const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    await openLanding(page);
    await page.waitForTimeout(1_000);
    await expect(page.getByTestId("landing-heart-3d")).toHaveCount(0); // nothing heavy until asked
    await page.getByTestId("landing-heart-view-lad").tap();
    await expect(caption(page)).toHaveText(/^LAD/);
    await page.getByTestId("landing-heart-explore").tap();
    await ready3d(page);
    await expect(page.getByTestId("landing-heart-hint")).toHaveText("Drag to rotate · Pinch to zoom");
    await page.getByTestId("landing-heart-done").tap();
    await expect(page.getByTestId("landing-heart-3d")).toHaveCount(0);
    await page.waitForTimeout(1_000); // the released canvas loses its context on purpose: not a failure
    await expect(page.getByTestId("landing-heart-explore")).toBeVisible();
    await expect(page.getByTestId("landing-heart-failed")).toHaveCount(0);
    await expect(caption(page)).toHaveText(/^LAD/);
    expect(await page.getByTestId("landing").evaluate((n) => n.scrollWidth - n.clientWidth)).toBe(0);
    await context.close();
  }
});

const CARDS = ["cad", "lad", "lcx", "rca"] as const;
const pressed = (page: Page) => Promise.all(CARDS.map((t) => page.getByTestId(`card-${t}`).getAttribute("aria-pressed")));

test("exploring the landing heart never changes a signed-in workspace", async ({ page, browser }) => {
  // Baseline: the same patient opened in a fresh session that never saw the landing page.
  const fresh = await browser.newContext();
  const clean = await fresh.newPage();
  await clean.goto("/?dataset=ZAS-0003");
  await expect(clean.getByTestId("card-cad")).toBeVisible({ timeout: 30_000 });
  const baseline = await pressed(clean);
  await fresh.close();

  await openLanding(page, { signInPassword: "right-password" });
  await ready3d(page);
  await page.getByTestId("landing-heart-view-lad").click();
  await expect(caption(page)).toHaveText(/^LAD/);
  await page.getByTestId("landing-heart-review").click(); // "Review a case" is the existing sign-in flow
  await expect(page.getByTestId("sign-in")).toBeVisible();
  await page.getByTestId("sign-in-username").fill("clinician");
  await page.getByTestId("sign-in-password").fill("right-password");
  await page.getByTestId("sign-in-submit").click();
  await expect(page.getByTestId("home-new-case")).toBeVisible({ timeout: 30_000 });
  await page.goto("/?dataset=ZAS-0003");
  await expect(page.getByTestId("card-cad")).toBeVisible({ timeout: 30_000 });
  expect(await pressed(page)).toEqual(baseline); // the landing's LAD selection did not reach the workspace
  await expect(page.getByTestId("card-lad")).toHaveAttribute("aria-pressed", "false");
});

test("accessibility: no serious or critical axe violations on the landing heart, image and 3D", async ({ page }) => {
  await openLanding(page);
  await ready3d(page);
  await page.getByTestId("landing-heart-view-lcx").click();
  const results = await new AxeBuilder({ page }).include("[data-testid='landing-heart']").exclude("canvas").analyze();
  const bad = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`)).toEqual([]);
});
