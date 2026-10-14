// Audit R02: an asynchronous save must land in the workspace that started it, never in the one on screen when it
// finishes, and must never clear another case's unsaved draft.
import { expect, test } from "@playwright/test";

const FIRST_LOAD = { timeout: 30_000 };

test("a save that finishes after switching patients marks only its own workspace as saved", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("page-new").click();
  await page.getByLabel("Prefill from a dataset patient").selectOption("ZAS-0003");
  await expect(page.getByTestId("case-status")).toContainText("Prediction up to date", FIRST_LOAD);

  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const requested = new Promise<void>((resolve) => { started = resolve; });
  await page.route("**/api/v1/analyze/full", async (route) => {
    const response = await route.fetch();
    started();
    await held;
    await route.fulfill({ response });
  });
  await page.getByTestId("save-case").click();
  await requested; // New case 1's save is in flight

  await page.getByTestId("page-library").click();
  await page.getByTestId("patient-ZAS-0004").click(); // another patient is on screen when it finishes
  await expect(page.getByTestId("card-cad")).toBeVisible(FIRST_LOAD);
  release();
  await page.waitForTimeout(1000);

  await expect(page.getByRole("heading", { name: /ZAS-0004/ })).toBeVisible();
  await expect(page.getByTestId("case-id")).toHaveCount(0); // ZAS-0004 is still unsaved
  await expect(page.getByTestId("save-case")).toBeVisible();

  await page.getByTestId(/^ws-tab-CASE-/).click(); // once saved, the tab carries the case number
  await expect(page.getByRole("heading", { name: /^CASE-/ })).toBeVisible();
  await expect(page.getByTestId("case-id")).toHaveText(/^CASE-\d{4}-\d{4}$/);
});

test("saving one new case keeps another new case's unsaved draft", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("page-new").click(); // New case 1
  await page.getByLabel("Prefill from a dataset patient").selectOption("ZAS-0003");
  await expect(page.getByTestId("case-status")).toContainText("Prediction up to date", FIRST_LOAD);

  await page.getByTestId("page-new").click(); // New case 2: its edits become the current draft
  await page.getByTestId("field-age").filter({ visible: true }).fill("63"); // two forms are mounted; one is shown
  const draftAge = () => page.evaluate(() => new Promise<unknown>((resolve) => {
    const open = indexedDB.open("novarion");
    open.onsuccess = () => {
      const get = open.result.transaction("drafts").objectStore("drafts").get("current");
      get.onsuccess = () => { resolve((get.result as { inputs?: Record<string, unknown> } | undefined)?.inputs?.age ?? null); open.result.close(); };
      get.onerror = () => resolve(null);
    };
    open.onerror = () => resolve(null);
  }));
  await expect.poll(draftAge, { timeout: 15_000 }).toBe(63);

  await page.getByTestId("ws-tab-New case 1").click();
  await page.getByTestId("save-case").click();
  await expect(page.getByTestId("case-id")).toHaveText(/^CASE-\d{4}-\d{4}$/, FIRST_LOAD);
  await page.waitForTimeout(500);
  expect(await draftAge()).toBe(63); // New case 2's draft survived New case 1's save
});

test("each open New case form has unique field ids, and labels focus their own input", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("page-new").click();
  await page.getByTestId("page-new").click(); // two New case forms mounted
  await expect(page.getByTestId("field-age")).toHaveCount(2); // both forms rendered before counting
  const ids = await page.locator("form [id]").evaluateAll((els) => els.map((e) => e.id));
  expect(ids.length).toBeGreaterThan(50);
  expect(new Set(ids).size).toBe(ids.length);
  await page.locator(`label[for$="-field-age"]`).filter({ visible: true }).click();
  await expect(page.getByTestId("field-age").filter({ visible: true })).toBeFocused();
});
