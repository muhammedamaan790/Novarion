// "3D heart" page (D-025): the reference anatomy with no case and no prediction; its own selection never touches an
// open case, and the case heart keeps rendering the Review Snapshots.
import AxeBuilder from "@axe-core/playwright";
import { readFileSync } from "node:fs";
import { expect, test, type Download } from "@playwright/test";

const FIRST_LOAD = { timeout: 30_000 };

test("the 3D heart page shows the anatomy without any case and explains each artery", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("home-anatomy").click();
  await expect(page).toHaveURL(/page=anatomy/);
  await expect(page.getByTestId("anatomy-page").locator("canvas")).toBeVisible(FIRST_LOAD);
  await expect(page.getByTestId("predictions")).toHaveCount(0); // no case, no prediction
  await expect(page.getByTestId("workspace-bar")).toHaveCount(0);

  await page.getByTestId("anatomy-select-lad").click();
  await expect(page.getByTestId("anatomy-select-lad")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("anatomy-selected")).toContainText("left anterior descending");
  await expect(page.getByTestId("anatomy-selected")).toContainText("anterior interventricular groove");
  await page.getByTestId("anatomy-select-rca").click();
  await expect(page.getByTestId("anatomy-selected")).toContainText("right coronary artery");
  await page.getByTestId("anatomy-view-posterior").click(); // camera presets work here too
  await page.getByTestId("anatomy-reset").click();
  await expect(page.getByTestId("anatomy-selected")).toHaveCount(0);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${process.env.E2E_BACKEND === "real" ? "../results/ui/real" : "../results/ui"}/15-anatomy.png` });
});

test("exploring the 3D heart never changes an open case, and the case still renders its own snapshot", async ({ page }) => {
  await page.goto("/?page=library");
  await page.getByTestId("patient-ZAS-0003").click();
  await expect(page.getByTestId("card-cad")).toBeVisible(FIRST_LOAD);
  await page.getByTestId("select-lcx").click();

  await page.getByTestId("page-anatomy").click();
  await page.getByTestId("anatomy-select-lad").click();
  await page.keyboard.press("3"); // shortcuts belong to the case workspace, not this page
  await expect(page.getByTestId("anatomy-select-lad")).toHaveAttribute("aria-pressed", "true");

  await page.getByTestId("ws-tab-ZAS-0003").click();
  await expect(page.getByTestId("card-lcx")).toHaveAttribute("aria-pressed", "true"); // untouched
  await expect(page.getByTestId("card-lad")).toHaveAttribute("aria-pressed", "false");

  await page.getByTestId("save-case").click();
  const downloads: Download[] = [];
  page.on("download", (d) => downloads.push(d));
  await page.getByTestId("snapshot").click();
  await expect.poll(() => downloads.length).toBe(2);
  const json = downloads.find((d) => d.suggestedFilename().endsWith(".json"))!;
  const stored = JSON.parse(readFileSync((await json.path())!, "utf8"));
  expect(stored.snapshot.image.data_url).toMatch(/^data:image\/png;base64,/); // rendered by the case heart
});

test("accessibility: no serious or critical axe violations on the 3D heart page", async ({ page }) => {
  await page.goto("/?page=anatomy");
  await expect(page.getByTestId("anatomy-page")).toBeVisible(FIRST_LOAD);
  await page.getByTestId("anatomy-select-lad").click();
  const results = await new AxeBuilder({ page }).exclude("canvas").analyze();
  const bad = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`)).toEqual([]);
});
