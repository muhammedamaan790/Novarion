// Outcome recording + learning-package export (plan §12B rules 1, 1b, 1e; §15 "package minimization",
// "verified-outcome trust"). The allowlists below mirror ml/novarion_ml/lifecycle/package.py exactly.
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import type { Meta } from "../api/client";
import { activeOutcomes, addOutcome, caseStatus, exportLearningPackage, outcomeBlocker, type OutcomeInput } from "./caseStore";
import { db, type CaseRecord } from "./db";

const PACKAGE_FIELDS = ["kind", "package_schema_version", "records"];
const RECORD_FIELDS = ["case_source", "learning_record_id", "outcomes"];
const OUTCOME_FIELDS = ["applies_to_input_sha256", "correction_reason", "inputs", "label_definition", "labels",
  "outcome_id", "outcome_status", "pseudonymous_study_id", "source_system", "source_type", "supersedes_outcome_id"];

const meta = {
  unknown_token: "UNKNOWN",
  features: [{ id: "age" }, { id: "ldl" }],
  targets: ["cad", "lad", "lcx", "rca"].map((id) => ({ id, display: id, label_definition: `def ${id}` })),
} as unknown as Meta;

function makeCase(id: string, source: CaseRecord["source"], inputs: Record<string, unknown>): CaseRecord {
  const analysis = { analysis_id: `a-${id}`, model_version: "1.0.1", stored_at: "2026-10-07T00:00:00Z" };
  return {
    case_id: id, number: Number(id.replace(/\D/g, "")) || 1, display_id: `CASE-2026-${id}`, case_schema_version: "1.0.0",
    created_at: "2026-10-07T00:00:00Z", updated_at: "2026-10-07T00:00:00Z", source,
    dataset_patient_id: source === "dataset" ? "ZAS-0001" : null,
    scenarios: [{ scenario_id: `s-${id}`, kind: "original", parent_scenario_id: null, state: "FROZEN", input_snapshot: inputs,
                  unit_status: {}, input_sha256: "a".repeat(64), current_analysis_id: `a-${id}`,
                  analyses: [analysis as never], created_at: "2026-10-07T00:00:00Z" }],
    reviews: [{ review_id: "r", scenario_id: `s-${id}`, analysis_id: `a-${id}`, note: "private note", limitations: [],
                created_at: "2026-10-07T00:00:00Z" }],
    snapshots: [],
  };
}

const outcome: OutcomeInput = {
  labels: { cad: 1, lad: 1, lcx: 0, rca: 0 }, source_type: "angiography_report", source_system: "hospital_ehr",
  pseudonymous_study_id: null, supersedes_outcome_id: null, correction_reason: null,
};

describe("outcomes and the learning package", () => {
  beforeEach(async () => {
    await db.cases.clear();
  });

  it("blocks dataset cases and incomplete inputs", () => {
    expect(outcomeBlocker(makeCase("1", "dataset", { age: 50, ldl: 100 }), meta)).toMatch(/already training data/);
    expect(outcomeBlocker(makeCase("2", "manual", { age: 50, ldl: "UNKNOWN" }), meta)).toMatch(/every input/);
    expect(outcomeBlocker(makeCase("3", "manual", { age: 50 }), meta)).toMatch(/every input/);
    expect(outcomeBlocker(makeCase("4", "manual", { age: 50, ldl: 100 }), meta)).toBeNull();
  });

  it("records pending outcomes bound to the scenario; corrections append and supersede", async () => {
    await db.cases.add(makeCase("5", "manual", { age: 50, ldl: 100 }));
    const first = await addOutcome("5", outcome, meta);
    expect(first.outcomes![0]!.outcome_status).toBe("pending");
    expect(first.outcomes![0]!.applies_to_scenario_id).toBe("s-5");
    expect(caseStatus(first)).toBe("Outcome recorded");
    const lrid = first.learning_record_id;
    await expect(addOutcome("5", { ...outcome, supersedes_outcome_id: first.outcomes![0]!.outcome_id }, meta))
      .rejects.toThrow(/reason/);
    const second = await addOutcome("5", { ...outcome, labels: { cad: 0, lad: 0, lcx: 0, rca: 0 },
      supersedes_outcome_id: first.outcomes![0]!.outcome_id, correction_reason: "data_entry_error" }, meta);
    expect(second.learning_record_id).toBe(lrid); // generated once, immutable
    expect(second.outcomes).toHaveLength(2); // append-only
    expect(activeOutcomes(second).map((o) => o.labels.cad)).toEqual([0]);
  });

  it("exports allowlisted fields only, always pending, never dataset cases", async () => {
    await db.cases.bulkAdd([makeCase("6", "manual", { age: 50, ldl: 100 }), makeCase("7", "dataset", { age: 60, ldl: 90 })]);
    await addOutcome("6", { ...outcome, pseudonymous_study_id: "  STUDY-7f3a " }, meta);
    const record = (await db.cases.get("7"))!;
    await db.cases.put({ ...record, learning_record_id: "x", outcomes: [] }); // even if one got in, it is excluded
    const pkg = await exportLearningPackage();
    const doc = JSON.parse(pkg.text);
    expect(pkg.records).toBe(1);
    expect(Object.keys(doc).sort()).toEqual(PACKAGE_FIELDS);
    expect(Object.keys(doc.records[0]).sort()).toEqual(RECORD_FIELDS);
    const o = doc.records[0].outcomes[0];
    expect(Object.keys(o).sort()).toEqual(OUTCOME_FIELDS);
    expect(o.outcome_status).toBe("pending");
    expect(o.pseudonymous_study_id).toBe("STUDY-7f3a");
    expect(o.inputs).toEqual({ age: 50, ldl: 100 });
    expect(pkg.text).not.toMatch(/private note|CASE-2026|created_at|stored_at|display_id|case_id/);
  });
});
