// Sign-in page (D-022). The test backend runs with sign-in off, so these flows stub the three /auth routes in the
// browser; the password checks themselves (hashing, lockout, 401 on every route) are tested in tests/test_auth.py.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const SIGNED_OUT = { auth_required: true, accounts_configured: true, user: null };

async function stubAuth(page: Page, password: string) {
  let user: string | null = null;
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({ json: { ...SIGNED_OUT, user } }));
  await page.route("**/api/v1/auth/login", async (route) => {
    const body = route.request().postDataJSON() as { username: string; password: string };
    if (body.password !== password) {
      await route.fulfill({ status: 401, json: { error_code: "INVALID_CREDENTIALS", message: "Wrong username or password.", details: {} } });
      return;
    }
    user = body.username;
    await route.fulfill({ json: { ...SIGNED_OUT, user } });
  });
  await page.route("**/api/v1/auth/logout", async (route) => {
    user = null;
    await route.fulfill({ json: SIGNED_OUT });
  });
}

/** Signed out, the public landing page comes first (D-028); its Sign in button opens the sign-in form. */
async function openSignIn(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("landing")).toBeVisible();
  await page.getByTestId("landing-sign-in").click();
  await expect(page.getByTestId("sign-in")).toBeVisible();
}

test("signed out: the landing page explains the problem and approach; Sign in opens the form, Back returns", async ({ page, baseURL }) => {
  await stubAuth(page, "right-password");
  const offOrigin: string[] = [];
  page.on("request", (r) => { if (new URL(r.url()).origin !== new URL(baseURL!).origin) offOrigin.push(r.url()); });
  await page.goto("/");
  await expect(page.getByTestId("landing")).toBeVisible();
  await expect(page.getByTestId("sign-in")).toHaveCount(0);
  await expect(page.getByTestId("landing-problem")).toContainText("coronary angiography");
  await expect(page.getByTestId("landing-approach")).toContainText("303 patients");
  await expect(page.getByTestId("landing-how")).toBeVisible();
  await expect(page.getByTestId("disclaimer")).toBeVisible();
  await expect(page.locator("img[src='/landing/heart.webp']")).toHaveJSProperty("complete", true);

  await page.getByTestId("landing-sign-in-cta").click();
  await expect(page.getByTestId("sign-in")).toBeVisible();
  await expect(page.getByTestId("sign-in-intro")).toBeVisible(); // the sign-in page itself is unchanged
  await page.goBack();
  await expect(page.getByTestId("landing")).toBeVisible();
  await page.getByTestId("landing-sign-in-nav").click();
  await expect(page.getByTestId("sign-in")).toBeVisible();
  expect(offOrigin).toEqual([]); // nothing from another origin: no CDN, font or remote image
});

// The landing hero's explorable heart (D-031, D-036) has its own suite: e2e/landing-heart.spec.ts.

test("sign-in gates the app: wrong password refused, then home with NEW CASE; sign out returns to the landing page", async ({ page }) => {
  await stubAuth(page, "right-password");
  const apiCalls: string[] = [];
  page.on("request", (r) => { if (/\/api\/v1\/(meta|patients)/.test(r.url())) apiCalls.push(r.url()); });
  await openSignIn(page);
  await expect(page.getByTestId("disclaimer")).toBeVisible();
  expect(apiCalls).toEqual([]); // nothing behind the gate is requested before sign-in

  await page.getByTestId("sign-in-username").fill("clinician");
  await page.getByTestId("sign-in-password").fill("guess");
  await page.getByTestId("sign-in-submit").click();
  await expect(page.getByTestId("sign-in-error")).toHaveText("Wrong username or password.");
  await expect(page.getByTestId("sign-in-password")).toHaveValue(""); // never kept after a failure

  await page.getByTestId("sign-in-password").fill("right-password");
  await page.getByTestId("sign-in-submit").click();
  await expect(page.getByTestId("home-new-case")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("signed-in-user")).toHaveText("clinician");

  expect(page.url()).not.toContain("#sign-in");

  await page.getByTestId("sign-out").click();
  await expect(page.getByTestId("landing")).toBeVisible();
});

test("an expired session (401 from any call) returns to the sign-in page", async ({ page }) => {
  await stubAuth(page, "right-password");
  await openSignIn(page);
  await page.getByTestId("sign-in-username").fill("clinician");
  await page.getByTestId("sign-in-password").fill("right-password");
  await page.getByTestId("sign-in-submit").click();
  await expect(page.getByTestId("home-new-case")).toBeVisible({ timeout: 30_000 });
  await page.route("**/api/v1/patients", (route) => // fetched only when the library opens (the home page loads evaluation)
    route.fulfill({ status: 401, json: { error_code: "UNAUTHENTICATED", message: "Sign in first.", details: {} } }));
  await page.getByTestId("home-library").click();
  await expect(page.getByTestId("sign-in")).toBeVisible();
});

test("accessibility: no serious or critical axe violations on the landing and sign-in pages", async ({ page }) => {
  await stubAuth(page, "right-password");
  const check = async () => {
    const results = await new AxeBuilder({ page }).analyze();
    const bad = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(bad.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`)).toEqual([]);
  };
  await page.goto("/");
  await expect(page.getByTestId("landing")).toBeVisible();
  await check();
  await page.getByTestId("landing-sign-in").click();
  await expect(page.getByTestId("sign-in")).toBeVisible();
  await check();
});
