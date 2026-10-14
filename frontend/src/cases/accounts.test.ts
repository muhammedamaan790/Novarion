// Audit R04: each signed-in account has its own case store; cases saved before accounts existed move only on request.
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { listBackups, selectAccountStorage } from "./backup";
import { legacyCases, listCases, loadDraft, moveLegacyCases } from "./caseStore";
import { LEGACY_DB, NovarionDB, db, type CaseRecord } from "./db";
import { completeAnalysis } from "./testFixtures";

function makeCase(id: string, number: number): CaseRecord {
  return {
    case_id: id, number, display_id: `CASE-2026-${String(number).padStart(4, "0")}`, case_schema_version: "1.0.0",
    created_at: "2026-10-12T00:00:00Z", updated_at: "2026-10-12T00:00:00Z", source: "manual", dataset_patient_id: null,
    scenarios: [{ scenario_id: `s-${id}`, kind: "original", parent_scenario_id: null, state: "FROZEN", input_snapshot: {},
                  unit_status: {}, input_sha256: "a".repeat(64), current_analysis_id: `a-${id}`,
                  analyses: [completeAnalysis(`a-${id}`)], created_at: "2026-10-12T00:00:00Z" } as never],
    reviews: [], snapshots: [],
  };
}

afterEach(async () => {
  await selectAccountStorage(null);
  for (const name of [LEGACY_DB, "novarion:alice", "novarion:bob"]) {
    const d = new NovarionDB(name);
    await d.cases.clear();
    await d.drafts.clear();
    d.close();
  }
});

describe("per-account case storage", () => {
  it("an account never sees another account's cases or drafts", async () => {
    await selectAccountStorage("alice");
    await db.cases.add(makeCase("alice-1", 1));
    await db.drafts.put({ draft_id: "current", inputs: { age: 61 }, unit_status: {}, dataset_record_id: null, source: "manual",
                          saved_at: "2026-10-12T00:00:00Z" });
    await selectAccountStorage("bob");
    expect(await listCases()).toEqual([]);
    expect(await loadDraft()).toBeUndefined();
    await selectAccountStorage("alice");
    expect((await listCases()).map((c) => c.case_id)).toEqual(["alice-1"]);
    expect((await loadDraft())?.inputs.age).toBe(61);
    await selectAccountStorage(null); // signed out / offline demo: the shared store, which alice's case never entered
    expect(await listCases()).toEqual([]);
  });

  it("cases saved before accounts are offered and moved only when asked, never deleted silently", async () => {
    await selectAccountStorage(null);
    await db.cases.add(makeCase("old-1", 1));
    await selectAccountStorage("alice");
    expect((await legacyCases()).map((c) => c.case_id)).toEqual(["old-1"]);
    expect(await listCases()).toEqual([]); // nothing moved yet
    const report = await moveLegacyCases();
    expect(report).toEqual({ moved: ["CASE-2026-0001"], kept: [] });
    expect((await listCases()).map((c) => c.case_id)).toEqual(["old-1"]);
    expect(await legacyCases()).toEqual([]);
    expect((await listBackups())[0]!.reason).toBe("before moving cases saved before accounts");
  });

  it("a shared case whose number is already used in the account stays where it is", async () => {
    await selectAccountStorage(null);
    await db.cases.add(makeCase("old-1", 1));
    await selectAccountStorage("bob");
    await db.cases.add(makeCase("bob-1", 1));
    const report = await moveLegacyCases();
    expect(report).toEqual({ moved: [], kept: ["CASE-2026-0001"] });
    expect((await legacyCases()).map((c) => c.case_id)).toEqual(["old-1"]); // still in the shared store
  });
});
