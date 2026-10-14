// Local case-store safety net (plan §11A "IndexedDB corruption"). Automatic backups live in a SEPARATE IndexedDB
// database, so they stay readable if the main store cannot be opened. The last 3 are kept. A corrupt or
// unopenable main store is never overwritten or deleted by the app: the user restores from a backup or a JSON export.
import Dexie, { type Table } from "dexie";
import { CASE_SCHEMA_VERSION, accountDbName, db, switchCaseDb, type CaseRecord } from "./db";
import { caseProblem } from "./validate";

export interface CaseBackup {
  id?: number;
  created_at: string;
  reason: string;
  case_count: number;
  json: string; // same format as "Export all (JSON)", so it can be re-imported as is
}

class BackupDB extends Dexie {
  backups!: Table<CaseBackup, number>;

  constructor(name = "novarion-backups") {
    super(name);
    this.version(1).stores({ backups: "++id, created_at" });
  }
}

export let backupDb = new BackupDB();

/** Switch cases, drafts and backups to `user`'s own stores (null = the shared store used without sign-in). An older
 *  schema in that store is backed up first, as at startup. Idempotent. */
export async function selectAccountStorage(user: string | null): Promise<void> {
  const name = accountDbName(user);
  const backupName = user ? `novarion-backups:${user}` : "novarion-backups";
  if (backupDb.name !== backupName) {
    backupDb.close();
    backupDb = new BackupDB(backupName);
  }
  if (db.name !== name) await backupBeforeUpgrade(2000, name);
  switchCaseDb(name);
}
export const KEEP_BACKUPS = 3;
const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

export function exportDocument(cases: unknown[]): string {
  return JSON.stringify({ case_schema_version: CASE_SCHEMA_VERSION, exported_at: now(), cases }, null, 1);
}

/** Store a backup of the given cases and prune to the newest KEEP_BACKUPS. Never throws (best effort). */
export async function storeBackup(cases: unknown[], reason: string): Promise<boolean> {
  try {
    await backupDb.transaction("rw", backupDb.backups, async () => {
      await backupDb.backups.add({ created_at: now(), reason, case_count: cases.length, json: exportDocument(cases) });
      const ids = await backupDb.backups.orderBy("id").primaryKeys();
      if (ids.length > KEEP_BACKUPS) await backupDb.backups.bulkDelete(ids.slice(0, ids.length - KEEP_BACKUPS));
    });
    return true;
  } catch {
    return false; // e.g. storage full: the case write itself already succeeded or failed on its own
  }
}

/** Back up the current main store (after a case is frozen, before a delete). */
export async function backupCases(reason: string): Promise<boolean> {
  try {
    return await storeBackup(await db.cases.toArray(), reason);
  } catch {
    return false;
  }
}

export const listBackups = () => backupDb.backups.orderBy("id").reverse().toArray();

/** Before Dexie upgrades an existing store to a newer schema version, copy its raw cases into a backup. */
export async function backupBeforeUpgrade(timeoutMs = 2000, dbName = db.name): Promise<"none" | "backed_up" | "failed"> {
  const target = db.verno * 10; // Dexie stores version × 10 natively
  const work = new Promise<"none" | "backed_up" | "failed">((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(dbName); // no version: opens whatever exists, never upgrades
    } catch {
      resolve("failed");
      return;
    }
    request.onerror = () => resolve("failed");
    request.onupgradeneeded = () => {
      request.transaction?.abort(); // the store did not exist: create nothing here
      resolve("none");
    };
    request.onsuccess = () => {
      const raw = request.result;
      if (raw.version >= target || !raw.objectStoreNames.contains("cases")) {
        raw.close();
        resolve("none");
        return;
      }
      const all = raw.transaction("cases").objectStore("cases").getAll();
      all.onsuccess = () => {
        raw.close();
        void storeBackup(all.result as unknown[], `before schema upgrade (v${raw.version / 10} → v${db.verno})`)
          .then((ok) => resolve(ok ? "backed_up" : "failed"));
      };
      all.onerror = () => {
        raw.close();
        resolve("failed");
      };
    };
  });
  return Promise.race([work, new Promise<"failed">((r) => setTimeout(() => r("failed"), timeoutMs))]);
}

export interface StorageHealth {
  ok: boolean;
  error: string | null;
}

/** Can the main store be opened? A failure is reported, never "repaired" by deleting data. */
export async function storageHealth(): Promise<StorageHealth> {
  try {
    await db.open();
    return { ok: true, error: null };
  } catch (err) {
    const e = err as { name?: string; message?: string };
    return { ok: false, error: `${e.name ?? "Error"}: ${e.message ?? "unknown"}` };
  }
}

/** A user-facing message for a failed write; storage-full gets actionable advice. */
export function storageErrorMessage(err: unknown): string {
  const e = err as { name?: string; message?: string; inner?: { name?: string } };
  if (e?.name === "QuotaExceededError" || e?.inner?.name === "QuotaExceededError") {
    return "browser storage is full. Export your cases (My cases → Export all), then delete cases you no longer need";
  }
  return e?.message ?? String(err);
}

/** Complete and internally consistent (audit R10): see caseProblem for the exact rules. */
export function isWellFormedCase(c: unknown): c is CaseRecord {
  return caseProblem(c) === null;
}
