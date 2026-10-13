// Flow D (plan §1A, §12A): save case → human review → Review Snapshot (PDF + JSON, verifiable hash) → case history
// → reopen from storage with the backend unreachable (stored analysis, never re-explained).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test, type Download, type Page } from "@playwright/test";
import { canonicalize } from "../src/cases/jcs";

const FIRST_LOAD = { timeout: 30_000 };

async function openPatient(page: Page, id: string) {
  await page.goto("/?page=library");
  await page.getByTestId(`patient-${id}`).click();
  await expect(page.getByTestId("card-cad")).toBeVisible(FIRST_LOAD);
}

test("dataset case: save → review → snapshot → history → reopen offline", async ({ page }) => {
  await openPatient(page, "ZAS-0003");
  await page.getByTestId("save-case").click();
  await expect(page.getByTestId("case-id")).toHaveText(/^CASE-\d{4}-0001$/);
  await expect(page.getByTestId("case-review-status")).toHaveText("Unreviewed");

  await page.getByTestId("review-open").click();
  await expect(page.getByTestId("review-form")).toContainText("Standard confidence (outside validated ranges)"); // pre-ticked from the output
  await page.getByLabel("What stood out?").fill("Typical chest pain dominates the CAD estimate; vessels all LOW.");
  await page.getByTestId("review-save").click();
  await expect(page.getByTestId("case-review-status")).toHaveText("Review recorded");

  const downloads: Download[] = [];
  page.on("download", (d) => downloads.push(d));
  await page.getByTestId("snapshot").click();
  await expect.poll(() => downloads.length).toBe(2); // PDF + JSON of the same stored snapshot
  const pdf = downloads.find((d) => d.suggestedFilename().endsWith(".pdf"))!;
  const json = downloads.find((d) => d.suggestedFilename().endsWith(".json"))!;
  expect(pdf.suggestedFilename()).toMatch(/^NOVARION Review Snapshot CASE-\d{4}-0001\.pdf$/);
  await pdf.saveAs(`${process.env.E2E_BACKEND === "real" ? "../results/ui/real" : "../results/ui"}/snapshot.pdf`);
  const stored = JSON.parse(readFileSync((await json.path())!, "utf8"));
  const recomputed = createHash("sha256").update(canonicalize(stored.snapshot)).digest("hex");
  expect(recomputed).toBe(stored.snapshot_sha256); // non-circular hash verifies independently
  expect(stored.snapshot.statement).toContain("Not a diagnostic report or medical record");
  expect(stored.snapshot.review.note).toContain("Typical chest pain");
  expect(stored.snapshot.image.data_url).toMatch(/^data:image\/png;base64,/);
  const png = Buffer.from(stored.snapshot.image.data_url.split(",")[1], "base64");
  expect(createHash("sha256").update(png).digest("hex")).toBe(stored.snapshot.image.image_sha256);
  expect(png.length).toBeGreaterThan(20_000); // a real render, not a blank frame
  await expect(page.getByTestId("case-bar")).toContainText("1 snapshot");

  // reopen from history with every API call blocked: the stored analysis renders without the backend
  await page.getByTestId("page-cases").click();
  await page.route("**/api/v1/**", (route) => route.abort());
  await page.getByTestId(/^case-CASE-/).first().click();
  await expect(page.getByTestId("card-lad")).toBeVisible();
  await expect(page.getByTestId("case-review-status")).toHaveText("Review recorded");
  await page.getByTestId("select-lad").click();
  await expect(page.getByTestId("why-panel")).toContainText("Why did the model predict this? · LAD"); // stored explanation
  await page.screenshot({ path: `${process.env.E2E_BACKEND === "real" ? "../results/ui/real" : "../results/ui"}/12-case.png` });
});

test("new case: save persists via /analyze/full; an edit becomes a new scenario, never an overwrite", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("page-new").click();
  await page.getByLabel("Prefill from a dataset patient").selectOption("ZAS-0004");
  await expect(page.getByTestId("case-status")).toContainText("Prediction up to date", FIRST_LOAD);
  await page.getByTestId("save-case").click();
  await expect(page.getByTestId("case-id")).toHaveText(/^CASE-\d{4}-0001$/);
  await expect(page.getByTestId("case-bar")).toContainText("Manual entry");

  const pulse = page.getByTestId("field-pulse_rate");
  await pulse.fill(String(Number(await pulse.inputValue()) + 30));
  await expect(page.getByTestId("save-case")).toHaveText("Save as new scenario", { timeout: 15_000 });
  await page.getByTestId("save-case").click();
  await expect(page.getByTestId("case-bar")).toContainText("scenario 2 (edited)");
  await page.getByTestId("page-cases").click();
  await expect(page.getByTestId("my-cases")).toContainText("2 scenarios");
});

test("unsaved draft survives a reload, is offered (never applied silently), and is cleared once saved", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("page-new").click();
  await page.getByLabel("Prefill from a dataset patient").selectOption("ZAS-0004");
  await expect(page.getByTestId("case-status")).toContainText("Prediction up to date", FIRST_LOAD);
  await page.getByTestId("field-pulse_rate").fill("97");
  // autosave is debounced: wait until the edited draft is actually in IndexedDB (slow CI runners need longer)
  await expect.poll(() => page.evaluate(() => new Promise<unknown>((resolve) => {
    const open = indexedDB.open("novarion");
    open.onsuccess = () => {
      const get = open.result.transaction("drafts").objectStore("drafts").get("current");
      get.onsuccess = () => { resolve((get.result as { inputs?: Record<string, unknown> } | undefined)?.inputs?.pulse_rate); open.result.close(); };
      get.onerror = () => resolve(null);
    };
    open.onerror = () => resolve(null);
  })), { timeout: 15_000 }).toBe(97);

  await page.reload();
  await page.getByTestId("page-new").click();
  await expect(page.getByTestId("draft-recovery")).toContainText("Recover unsaved draft");
  await expect(page.getByTestId("field-pulse_rate")).toHaveValue(""); // nothing applied until the user chooses
  await page.getByTestId("draft-recover").click();
  await expect(page.getByTestId("field-pulse_rate")).toHaveValue("97");
  await expect(page.getByTestId("case-status")).toContainText("Prediction up to date", FIRST_LOAD);

  await page.getByTestId("save-case").click();
  await expect(page.getByTestId("case-id")).toHaveText(/^CASE-\d{4}-\d{4}$/);
  await page.reload();
  await page.getByTestId("page-new").click();
  await expect(page.getByTestId("draft-recovery")).toHaveCount(0); // saved → no longer a draft
});

test("a discarded draft is gone", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("page-new").click();
  await page.getByLabel("Prefill from a dataset patient").selectOption("ZAS-0006");
  await expect(page.getByTestId("case-status")).toContainText("Prediction up to date", FIRST_LOAD);
  await page.waitForTimeout(1500);
  await page.reload();
  await page.getByTestId("page-new").click();
  await page.getByTestId("draft-discard").click();
  await page.reload();
  await page.getByTestId("page-new").click();
  await expect(page.getByTestId("draft-recovery")).toHaveCount(0);
});

async function setStoredModelVersion(page: Page, version: string) {
  await page.evaluate(async (v) => {
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open("novarion");
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const tx = open.result.transaction("cases", "readwrite");
        const store = tx.objectStore("cases");
        const all = store.getAll();
        all.onsuccess = () => {
          for (const c of all.result) {
            for (const s of c.scenarios) for (const a of s.analyses) a.model_version = v; // simulate an older model
            store.put(c);
          }
        };
        tx.oncomplete = () => resolve();
      };
    });
  }, version);
}

test("re-analysis with a newer model: new analysis on the same scenario, old one kept, review status resets", async ({ page }) => {
  await openPatient(page, "ZAS-0003");
  await page.getByTestId("save-case").click();
  await page.getByTestId("review-open").click();
  await page.getByTestId("review-save").click();
  await expect(page.getByTestId("case-review-status")).toHaveText("Review recorded");
  await setStoredModelVersion(page, "0.9.0");
  await page.getByTestId("page-cases").click();
  await page.getByTestId(/^case-CASE-/).first().click();
  await expect(page.getByTestId("case-bar")).toContainText("Stored with model v0.9.0");
  await page.getByTestId("reanalyze").click();
  await expect(page.getByTestId("case-bar")).toContainText("2 analyses on this scenario (older ones kept)");
  await expect(page.getByTestId("case-review-status")).toHaveText("Unreviewed"); // the review belongs to the old analysis
  await expect(page.getByTestId("reanalyze")).toHaveCount(0);
});

test("cases export → import into a fresh browser; a tampered export is rejected", async ({ page, browser }) => {
  await openPatient(page, "ZAS-0006");
  await page.getByTestId("save-case").click();
  await page.getByTestId("snapshot").click();
  await expect(page.getByTestId("case-bar")).toContainText("1 snapshot");
  await page.getByTestId("page-cases").click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("cases-export").click()]);
  const exported = readFileSync((await download.path())!, "utf8");

  const fresh = await browser.newContext(); // empty IndexedDB, like another machine
  const other = await fresh.newPage();
  await other.goto("/");
  await other.getByTestId("page-cases").click();
  await other.getByTestId("cases-import-file").setInputFiles({ name: "cases.json", mimeType: "application/json",
    buffer: Buffer.from(exported) });
  await expect(other.getByTestId("cases-import-report")).toContainText(/Imported: CASE-\d{4}-0001/);
  await other.getByTestId(/^case-CASE-/).first().click();
  await expect(other.getByTestId("card-cad")).toBeVisible();
  await other.getByTestId("page-cases").click(); // opening a case left the My cases page

  const doc = JSON.parse(exported);
  doc.cases[0].case_id = "11111111-2222-4333-8444-555555555555";
  doc.cases[0].snapshots[0].stored_snapshot.snapshot.review = { note: "edited after export" };
  await other.getByTestId("cases-import-file").setInputFiles({ name: "tampered.json", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(doc)) });
  await expect(other.getByTestId("cases-import-report")).toContainText("Review Snapshot hash does not verify");
  await fresh.close();
});
