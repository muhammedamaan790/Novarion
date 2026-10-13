// Open-patient workspaces (D-023): one workspace per open case, each keeping its own state; a search box over them.
import { expect, test, type Page } from "@playwright/test";

const FIRST_LOAD = { timeout: 30_000 };

async function openFromLibrary(page: Page, id: string) {
  await page.getByTestId("page-library").click();
  await page.getByTestId(`patient-${id}`).click();
  await expect(page.getByRole("heading", { name: new RegExp(id) })).toBeVisible(FIRST_LOAD);
  await expect(page.getByTestId("card-cad")).toBeVisible(FIRST_LOAD);
}

test("each open patient keeps its own tab and selection; reopening focuses instead of duplicating", async ({ page }) => {
  await page.goto("/");
  await openFromLibrary(page, "ZAS-0003");
  await page.getByTestId("select-lad").click();
  await page.getByTestId("case-tab-why").click();
  await expect(page.getByTestId("why-panel")).toContainText("· LAD");

  await openFromLibrary(page, "ZAS-0004");
  await expect(page.getByTestId("case-tab-result")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("workspace-bar")).toContainText("Open (2)");

  await page.getByTestId("ws-tab-ZAS-0003").click();
  await expect(page.getByRole("heading", { name: /ZAS-0003/ })).toBeVisible();
  await expect(page.getByTestId("case-tab-why")).toHaveAttribute("aria-selected", "true"); // where we left it
  await expect(page.getByTestId("why-panel")).toContainText("· LAD");

  await openFromLibrary(page, "ZAS-0004"); // already open: focused, not duplicated
  await expect(page.getByTestId("workspace-bar")).toContainText("Open (2)");
});

test("a new case keeps its typed values while other patients are viewed", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("page-new").click();
  await page.getByLabel("Prefill from a dataset patient").selectOption("ZAS-0006");
  await expect(page.getByTestId("case-status")).toContainText("Prediction up to date", FIRST_LOAD);
  await page.getByTestId("field-pulse_rate").fill("97");
  await expect(page.getByTestId("case-status")).toContainText("Prediction up to date", FIRST_LOAD);

  await openFromLibrary(page, "ZAS-0003");
  await page.getByTestId("ws-tab-New case 1").click();
  await expect(page.getByTestId("field-pulse_rate")).toHaveValue("97");
  await expect(page.getByTestId("live-summary")).toBeVisible();

  await page.getByTestId("page-new").click(); // a second new case is its own workspace
  await expect(page.getByRole("heading", { name: "New case 2" })).toBeVisible();
  await expect(page.getByTestId("workspace-bar")).toContainText("Open (3)");
});

test("search finds an open patient by ID or details, or offers to open one from the library", async ({ page }) => {
  await page.goto("/");
  await openFromLibrary(page, "ZAS-0003");
  await openFromLibrary(page, "ZAS-0004");
  const search = page.getByTestId("workspace-search");

  await search.fill("0003");
  await expect(page.getByTestId("ws-tab-ZAS-0003")).toBeVisible();
  await expect(page.getByTestId("ws-tab-ZAS-0004")).toHaveCount(0);
  await search.press("Enter");
  await expect(page.getByRole("heading", { name: /ZAS-0003/ })).toBeVisible();

  await search.fill("female hypertension"); // ZAS-0004's details, not its ID
  await expect(page.getByTestId("ws-tab-ZAS-0004")).toBeVisible();
  await expect(page.getByTestId("ws-tab-ZAS-0003")).toHaveCount(0);

  await search.fill("6"); // not open yet
  await page.getByTestId("workspace-open-match").click();
  await expect(page.getByRole("heading", { name: /ZAS-0006/ })).toBeVisible(FIRST_LOAD);
  await expect(page.getByTestId("workspace-bar")).toContainText("Open (3)");

  await search.fill("nobody");
  await expect(page.getByTestId("workspace-no-match")).toBeVisible();
});

test("closing a workspace shows its neighbour; closing the last one returns home", async ({ page }) => {
  await page.goto("/");
  await openFromLibrary(page, "ZAS-0003");
  await openFromLibrary(page, "ZAS-0004");
  await page.getByTestId("ws-close-ZAS-0004").click();
  await expect(page.getByRole("heading", { name: /ZAS-0003/ })).toBeVisible();
  await expect(page).toHaveURL(/dataset=ZAS-0003/);
  await page.getByTestId("ws-close-ZAS-0003").click();
  await expect(page.getByTestId("home-new-case")).toBeVisible();
  await expect(page.getByTestId("workspace-bar")).toHaveCount(0);
});
