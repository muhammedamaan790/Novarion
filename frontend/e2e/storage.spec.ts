// Local case storage robustness (plan §11A "IndexedDB corruption", Days 15–17 "IndexedDB quota/corruption").
import { expect, test } from "@playwright/test";

const FIRST_LOAD = { timeout: 30_000 };

test("deleting a case asks first, keeps an automatic backup, and frees the case", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("patient-ZAS-0003").click();
  await expect(page.getByTestId("card-cad")).toBeVisible(FIRST_LOAD);
  await page.getByTestId("save-case").click();
  await expect(page.getByTestId("case-id")).toHaveText(/^CASE-\d{4}-0001$/);
  await page.getByTestId("tab-cases").click();
  const display = (await page.getByTestId(/^case-CASE-/).first().getAttribute("data-testid"))!.replace("case-", "");

  await page.getByTestId(`case-delete-${display}`).click();
  await expect(page.getByText(`Delete ${display} from this browser? A backup is kept.`)).toBeVisible();
  await page.getByTestId(`case-delete-confirm-${display}`).click();
  await expect(page.getByTestId(`case-${display}`)).toHaveCount(0);
  await expect(page.getByTestId("backups")).toContainText("before delete");
});

test("an unopenable case store is reported and left untouched", async ({ page }) => {
  // simulate a damaged / unavailable store: opening "novarion" fails; record any attempt to delete a database
  await page.addInitScript(() => {
    const w = window as unknown as { __deletes: string[] };
    w.__deletes = [];
    const open = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (name: string, version?: number) {
      if (name === "novarion") return open.call(this, name, 0); // version 0 → TypeError, like an unreadable store
      return version === undefined ? open.call(this, name) : open.call(this, name, version);
    };
    const del = IDBFactory.prototype.deleteDatabase;
    IDBFactory.prototype.deleteDatabase = function (name: string) {
      w.__deletes.push(name);
      return del.call(this, name);
    };
  });
  await page.goto("/");
  await page.getByTestId("tab-cases").click();
  await expect(page.getByTestId("storage-error")).toContainText("could not be opened", FIRST_LOAD);
  await expect(page.getByTestId("storage-error")).toContainText("Nothing was changed or deleted");
  await page.getByTestId("tab-dataset").click(); // the rest of the app keeps working without case storage
  await page.getByTestId("patient-ZAS-0003").click();
  await expect(page.getByTestId("card-cad")).toBeVisible(FIRST_LOAD);
  expect(await page.evaluate(() => (window as unknown as { __deletes: string[] }).__deletes)).toEqual([]);
});
