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

test("sign-in gates the app: wrong password refused, then home with NEW CASE; sign out returns to sign-in", async ({ page }) => {
  await stubAuth(page, "right-password");
  const apiCalls: string[] = [];
  page.on("request", (r) => { if (/\/api\/v1\/(meta|patients)/.test(r.url())) apiCalls.push(r.url()); });
  await page.goto("/");
  await expect(page.getByTestId("sign-in")).toBeVisible();
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

  await page.getByTestId("sign-out").click();
  await expect(page.getByTestId("sign-in")).toBeVisible();
});

test("an expired session (401 from any call) returns to the sign-in page", async ({ page }) => {
  await stubAuth(page, "right-password");
  await page.goto("/");
  await page.getByTestId("sign-in-username").fill("clinician");
  await page.getByTestId("sign-in-password").fill("right-password");
  await page.getByTestId("sign-in-submit").click();
  await expect(page.getByTestId("home-new-case")).toBeVisible({ timeout: 30_000 });
  await page.route("**/api/v1/patients", (route) => // fetched only when the library opens (the home page loads evaluation)
    route.fulfill({ status: 401, json: { error_code: "UNAUTHENTICATED", message: "Sign in first.", details: {} } }));
  await page.getByTestId("home-library").click();
  await expect(page.getByTestId("sign-in")).toBeVisible();
});

test("accessibility: no serious or critical axe violations on the sign-in page", async ({ page }) => {
  await stubAuth(page, "right-password");
  await page.goto("/");
  await expect(page.getByTestId("sign-in")).toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  const bad = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`)).toEqual([]);
});
