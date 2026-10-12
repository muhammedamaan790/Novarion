// Local storage safety net (plan §11A "IndexedDB corruption"; plan Days 15–17 "IndexedDB quota/corruption").
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { backupBeforeUpgrade, backupDb, KEEP_BACKUPS, listBackups, storageErrorMessage, storeBackup } from "./backup";
import { addReview, deleteCase, listCases, listCasesChecked } from "./caseStore";
import { db, type CaseRecord } from "./db";

function makeCase(id: string): CaseRecord {
  return {
    case_id: id, number: Number(id), display_id: `CASE-2026-000${id}`, case_schema_version: "1.0.0",
    created_at: "2026-10-12T00:00:00Z", updated_at: "2026-10-12T00:00:00Z", source: "manual", dataset_patient_id: null,
    scenarios: [{ scenario_id: `s${id}`, kind: "original", parent_scenario_id: null, state: "FROZEN", input_snapshot: {},
                  unit_status: {}, input_sha256: "a".repeat(64), current_analysis_id: `a${id}`,
                  analyses: [{ analysis_id: `a${id}`, model_version: "1.0.2" } as never], created_at: "2026-10-12T00:00:00Z" }],
    reviews: [], snapshots: [],
  };
}

const settle = () => new Promise((r) => setTimeout(r, 50));

describe("automatic local backups and damaged storage", () => {
  beforeEach(async () => {
    await db.cases.clear();
    await backupDb.backups.clear();
  });

  it("keeps only the newest backups, in a separate database", async () => {
    for (let i = 0; i < KEEP_BACKUPS + 2; i++) await storeBackup([{ i }], `test ${i}`);
    const kept = await listBackups();
    expect(kept.map((b) => b.reason)).toEqual(["test 4", "test 3", "test 2"]);
    expect(backupDb.name).not.toBe(db.name);
    expect(JSON.parse(kept[0]!.json).cases).toEqual([{ i: 4 }]); // re-importable export format
  });

  it("backs up after every committed case write, and before a delete", async () => {
    await db.cases.add(makeCase("1"));
    await addReview("1", "note", []);
    await settle();
    expect((await listBackups())[0]!.reason).toBe("after addReview");
    await deleteCase("1");
    const [latest] = await listBackups();
    expect(latest!.reason).toBe("before delete");
    expect(JSON.parse(latest!.json).cases[0].case_id).toBe("1"); // the backup still holds the deleted case
    expect(await db.cases.count()).toBe(0);
  });

  it("hides damaged records without touching them", async () => {
    await db.cases.add(makeCase("2"));
    await db.cases.add({ case_id: "broken", number: 3 } as unknown as CaseRecord);
    const checked = await listCasesChecked();
    expect(checked.cases.map((c) => c.case_id)).toEqual(["2"]);
    expect(checked.unreadable).toBe(1);
    expect(await listCases()).toHaveLength(1);
    expect(await db.cases.get("broken")).toBeDefined(); // never deleted or overwritten
  });

  it("copies an older-schema store aside before an upgrade", async () => {
    db.close();
    await new Promise<void>((resolve, reject) => {
      const del = indexedDB.deleteDatabase("novarion");
      del.onsuccess = () => resolve();
      del.onerror = () => reject(del.error);
    });
    await new Promise<void>((resolve) => {
      const req = indexedDB.open("novarion", 10); // Dexie v1 = native version 10
      req.onupgradeneeded = () => req.result.createObjectStore("cases", { keyPath: "case_id" }).put(makeCase("9"));
      req.onsuccess = () => { req.result.close(); resolve(); };
    });
    expect(await backupBeforeUpgrade()).toBe("backed_up");
    const [latest] = await listBackups();
    expect(latest!.reason).toMatch(/before schema upgrade/);
    expect(JSON.parse(latest!.json).cases[0].case_id).toBe("9");
    await db.open(); // Dexie then upgrades the store; the case survives the upgrade
    expect(await db.cases.get("9")).toBeDefined();
    expect(await backupBeforeUpgrade()).toBe("none"); // already current: nothing to do
  });

  it("explains a full storage quota", () => {
    expect(storageErrorMessage({ name: "QuotaExceededError" })).toMatch(/storage is full/);
    expect(storageErrorMessage({ name: "AbortError", inner: { name: "QuotaExceededError" } })).toMatch(/Export your cases/);
    expect(storageErrorMessage(new Error("boom"))).toBe("boom");
  });
});
