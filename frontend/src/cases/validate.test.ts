// Audit R10: incomplete or inconsistent case records are rejected with a reason; complete ones pass.
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { importCases, listCases } from "./caseStore";
import type { CaseRecord } from "./db";
import { completeAnalysis } from "./testFixtures";
import { caseProblem } from "./validate";

function validCase(): CaseRecord {
  return {
    case_id: "c1", number: 1, display_id: "CASE-2026-0001", case_schema_version: "1.0.0",
    created_at: "2026-10-12T00:00:00Z", updated_at: "2026-10-12T00:00:00Z", source: "manual", dataset_patient_id: null,
    scenarios: [{ scenario_id: "s1", kind: "original", parent_scenario_id: null, state: "FROZEN", input_snapshot: { age: 50 },
                  unit_status: {}, input_sha256: "a".repeat(64), current_analysis_id: "a1",
                  analyses: [completeAnalysis("a1")], created_at: "2026-10-12T00:00:00Z" } as never],
    reviews: [{ review_id: "r1", scenario_id: "s1", analysis_id: "a1", note: "", limitations: [], created_at: "2026-10-12T00:00:00Z" }],
    snapshots: [],
  };
}

const broken = (mutate: (c: CaseRecord & Record<string, unknown>) => void) => {
  const c = structuredClone(validCase()) as CaseRecord & Record<string, unknown>;
  mutate(c);
  return caseProblem(c);
};
const analysis = (c: CaseRecord) => c.scenarios[0]!.analyses[0] as unknown as Record<string, Record<string, Record<string, unknown>>>;

describe("case validation", () => {
  it("accepts a complete case", () => {
    expect(caseProblem(validCase())).toBeNull();
  });

  it("rejects the audit's example: an analysis that is only an id", () => {
    expect(broken((c) => { c.scenarios[0]!.analyses = [{ analysis_id: "a1" } as never]; })).toMatch(/model version/);
  });

  it("rejects missing or impossible prediction values", () => {
    expect(broken((c) => { delete analysis(c).targets!.rca; })).toMatch(/no RCA prediction/);
    expect(broken((c) => { analysis(c).targets!.lad!.probability = Number.NaN; })).toMatch(/lad values out of range/);
    expect(broken((c) => { analysis(c).targets!.cad!.probability = 1.5; })).toMatch(/cad values out of range/);
    expect(broken((c) => { analysis(c).targets!.lcx!.model_confidence = "medium"; })).toMatch(/lcx confidence unknown/);
    expect(broken((c) => { delete (analysis(c) as Record<string, unknown>).explanations; })).toMatch(/explanations/);
  });

  it("rejects bad hashes, ids and timestamps", () => {
    expect(broken((c) => { (analysis(c) as Record<string, unknown>).input_sha256 = "xyz"; })).toMatch(/input hash/);
    expect(broken((c) => { c.display_id = "CASE-1"; })).toMatch(/case id/);
    expect(broken((c) => { c.created_at = "yesterday"; })).toMatch(/timestamps/);
    expect(broken((c) => { c.dataset_patient_id = "PATIENT-7"; })).toMatch(/dataset patient id/);
  });

  it("rejects references to things that do not exist", () => {
    expect(broken((c) => { c.scenarios[0]!.current_analysis_id = "a9"; })).toMatch(/current analysis missing/);
    expect(broken((c) => { c.reviews[0]!.analysis_id = "a9"; })).toMatch(/review r1: refers to a missing analysis/);
    expect(broken((c) => {
      c.snapshots = [{ snapshot_id: "x", scenario_id: "s9", analysis_id: "a1", exported_at: "",
                       stored_snapshot: { snapshot: {}, snapshot_sha256: "c".repeat(64) } } as never];
    })).toMatch(/snapshot x: refers to a missing analysis/);
    expect(broken((c) => {
      c.outcomes = [{ outcome_id: "o", applies_to_scenario_id: "s1", labels: { cad: 1, lad: 2, lcx: 0, rca: 0 } } as never];
    })).toMatch(/labels must be 0 or 1/);
  });

  it("rejects non-objects and empty scenario lists", () => {
    expect(caseProblem(null)).toBe("not a case record");
    expect(broken((c) => { c.scenarios = []; })).toBe("no scenarios");
  });
});

describe("importing cases", () => {
  it("rejects a malformed case with its reason and still imports the valid one", async () => {
    const good = validCase();
    const bad = { ...validCase(), case_id: "c2", number: 2, display_id: "CASE-2026-0002" };
    bad.scenarios = [{ ...bad.scenarios[0]!, analyses: [{ analysis_id: "a1" } as never] }];
    const report = await importCases(JSON.stringify({ case_schema_version: "1.0.0", cases: [good, bad] }));
    expect(report.imported).toEqual(["CASE-2026-0001"]);
    expect(report.rejected).toEqual(["CASE-2026-0002: analysis a1: no model version"]);
    expect((await listCases()).map((c) => c.case_id)).toEqual(["c1"]); // the malformed record never entered the store
  });
});
