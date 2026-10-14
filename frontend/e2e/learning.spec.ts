// Flow D step 1–2 (plan §1A, §12B) + Model Center: record an outcome (always PENDING) on a saved new case, export the
// allowlisted learning package; the Model Center is read-only and shows registry, gate report, replay and audit log.
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const FIRST_LOAD = { timeout: 30_000 };
const REAL = process.env.E2E_BACKEND === "real";

test("outcome: recorded as pending on the saved scenario, corrected append-only, exported allowlisted", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("page-new").click();
  await page.getByLabel("Prefill from a dataset patient").selectOption("ZAS-0004");
  await expect(page.getByTestId("case-status")).toContainText("Prediction up to date", FIRST_LOAD);
  await page.getByTestId("save-case").click();
  await expect(page.getByTestId("case-id")).toHaveText(/^CASE-\d{4}-0001$/);

  await page.getByTestId("outcome-open").click();
  const form = page.getByTestId("outcome-form");
  await expect(form).toContainText("never the model output");
  await expect(page.getByTestId("outcome-save")).toBeDisabled(); // every target needs an explicit label
  for (const [t, v] of [["cad", 1], ["lad", 1], ["lcx", 0], ["rca", 0]] as const) {
    await page.getByTestId(`outcome-${t}-${v}`).check();
  }
  await page.getByTestId("outcome-save").click();
  await expect(page.getByTestId("case-review-status")).toHaveText("Outcome recorded (pending)");
  await expect(page.getByTestId("outcome-summary")).toContainText("pending verification");

  // a correction needs a reason and appends a superseding record
  await page.getByTestId("outcome-open").click();
  await page.getByTestId("outcome-lcx-1").check();
  for (const [t, v] of [["cad", 1], ["lad", 1], ["rca", 0]] as const) await page.getByTestId(`outcome-${t}-${v}`).check();
  await expect(page.getByTestId("outcome-save")).toBeDisabled();
  await page.getByTestId("outcome-correction-reason").selectOption("data_entry_error");
  await page.getByTestId("outcome-save").click();
  await expect(page.getByTestId("outcome-summary")).toContainText("2 records incl. corrections");

  await page.getByTestId("page-cases").click();
  const download = page.waitForEvent("download");
  await page.getByTestId("learning-package-export").click();
  const pkg = JSON.parse(readFileSync((await (await download).path())!, "utf8"));
  expect(pkg.kind).toBe("novarion_learning_package");
  expect(pkg.records).toHaveLength(1);
  const outcomes = pkg.records[0].outcomes;
  expect(outcomes).toHaveLength(2);
  expect(outcomes.every((o: { outcome_status: string }) => o.outcome_status === "pending")).toBe(true);
  expect(outcomes[1].supersedes_outcome_id).toBe(outcomes[0].outcome_id);
  expect(JSON.stringify(pkg)).not.toMatch(/CASE-\d{4}|created_at|display_id|case_id|note/);
});

test("dataset patients cannot receive outcomes (already training data)", async ({ page }) => {
  await page.goto("/?page=library");
  await page.getByTestId("patient-ZAS-0003").click();
  await expect(page.getByTestId("card-cad")).toBeVisible(FIRST_LOAD);
  await page.getByTestId("save-case").click();
  await expect(page.getByTestId("case-id")).toBeVisible();
  await expect(page.getByTestId("outcome-open")).toHaveCount(0);
});

test("Model Center: production status, registry, replay study and audit log; no promote control", async ({ page }) => {
  await page.goto("/?page=models");
  const center = page.getByTestId("model-center");
  await expect(center).toBeVisible(FIRST_LOAD);
  await expect(page.getByTestId("mc-production")).toContainText("READY");
  await expect(page.getByTestId("mc-registry")).toContainText("production");
  await expect(page.getByTestId("replay-study")).toContainText("NOT temporal validation");
  await expect(page.getByTestId("mc-log-status")).not.toHaveText("HASH CHAIN BROKEN");
  await expect(center.getByRole("button", { name: /promote/i })).toHaveCount(0); // CLI-only
  if (!REAL) { // the contract mock carries a rejected candidate with a gate report
    await center.getByRole("button", { name: "FAIL" }).click();
    await expect(page.getByTestId("gate-report")).toContainText("pre-promotion validation evidence");
    // D-037: the paired ΔAUC chart reads the report's own numbers (mock LCX: 0.770 − 0.800, CI [−0.09, 0.02])
    await expect(page.getByTestId("delta-auc-chart")).toBeVisible();
    await expect(page.getByTestId("delta-auc-lcx")).toContainText("−0.030");
  } else { // D-037: the replay study is drawn as learning curves plus gate outcomes, one curve per vessel
    for (const t of ["cad", "lad", "lcx", "rca"]) await expect(page.getByTestId(`learning-curve-${t}`)).toBeVisible();
    await expect(page.getByTestId("gate-outcomes")).toBeVisible();
    await expect(page.getByTestId("failed-rules")).toContainText("of 20");
  }
  await page.screenshot({ path: `${REAL ? "../results/ui/real" : "../results/ui"}/13-model-center.png`, fullPage: true });
});
