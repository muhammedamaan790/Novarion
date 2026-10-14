// Audit R04: with sign-in on, each account sees only its own locally stored cases (sign-in stubbed in the browser,
// as in auth.spec.ts; the real password checks are tested in tests/test_auth.py).
import { expect, test, type Page } from "@playwright/test";

const FIRST_LOAD = { timeout: 30_000 };

async function stubAuth(page: Page) {
  let user: string | null = null;
  const session = () => ({ auth_required: true, accounts_configured: true, user });
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({ json: session() }));
  await page.route("**/api/v1/auth/login", async (route) => {
    user = (route.request().postDataJSON() as { username: string }).username;
    await route.fulfill({ json: session() });
  });
  await page.route("**/api/v1/auth/logout", async (route) => {
    user = null;
    await route.fulfill({ json: session() });
  });
}

async function signIn(page: Page, username: string) {
  await expect(page.getByTestId("sign-in")).toBeVisible(FIRST_LOAD);
  await page.getByTestId("sign-in-username").fill(username);
  await page.getByTestId("sign-in-password").fill("password");
  await page.getByTestId("sign-in-submit").click();
  await expect(page.getByTestId("home-new-case")).toBeVisible(FIRST_LOAD);
}

test("each account sees only its own saved cases", async ({ page }) => {
  await stubAuth(page);
  await page.goto("/");
  await signIn(page, "alice");
  await page.getByTestId("page-library").click();
  await page.getByTestId("patient-ZAS-0003").click();
  await expect(page.getByTestId("card-cad")).toBeVisible(FIRST_LOAD);
  await page.getByTestId("save-case").click();
  await expect(page.getByTestId("case-id")).toHaveText(/^CASE-\d{4}-0001$/);
  await page.getByTestId("page-cases").click();
  await expect(page.getByTestId("storage-scope")).toContainText("for your account only");
  await expect(page.getByTestId(/^case-CASE-/)).toHaveCount(1);

  await page.getByTestId("sign-out").click();
  await signIn(page, "bob");
  await page.getByTestId("page-cases").click();
  await expect(page.getByTestId("my-cases")).toBeVisible();
  await expect(page.getByTestId(/^case-CASE-/)).toHaveCount(0); // alice's case is not in bob's store

  await page.getByTestId("sign-out").click();
  await signIn(page, "alice");
  await page.getByTestId("page-cases").click();
  await expect(page.getByTestId(/^case-CASE-/)).toHaveCount(1);
});
