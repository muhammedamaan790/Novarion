// Case operations. Each write is a single IndexedDB transaction, so a case is never half-saved (plan §1 "the client
// commits it in a single IndexedDB transaction"). Status is DERIVED: an analysis is reviewed iff a review references it.
import { api, type DisplayAnalysis, type InputValue, type Meta, type PatientBundle } from "../api/client";
import { CASE_SCHEMA_VERSION, db, type CaseRecord, type CaseSource, type DraftRecord, type OutcomeRecord,
  type PersistedAnalysis, type Review, type Scenario, type SnapshotRecord, type StoredSnapshot } from "./db";

const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z"); // RFC 3339 UTC (plan §11A "Timestamps")
const uuid = () => crypto.randomUUID();

export type CaseStatus = "Unreviewed" | "Reviewed" | "Outcome recorded";

export function currentScenario(c: CaseRecord): Scenario {
  return c.scenarios[c.scenarios.length - 1]!;
}

export function currentAnalysis(c: CaseRecord): PersistedAnalysis {
  const s = currentScenario(c);
  return s.analyses.find((a) => a.analysis_id === s.current_analysis_id)!;
}

export function reviewsFor(c: CaseRecord, analysisId: string): Review[] {
  return c.reviews.filter((r) => r.analysis_id === analysisId);
}

export function caseStatus(c: CaseRecord): CaseStatus {
  if (c.outcomes?.length) return "Outcome recorded";
  return reviewsFor(c, currentAnalysis(c).analysis_id).length ? "Reviewed" : "Unreviewed";
}

/** The live (non-superseded) outcomes of a case: corrections append and supersede, nothing is mutated. */
export function activeOutcomes(c: CaseRecord): OutcomeRecord[] {
  const superseded = new Set((c.outcomes ?? []).map((o) => o.supersedes_outcome_id).filter(Boolean));
  return (c.outcomes ?? []).filter((o) => !superseded.has(o.outcome_id));
}

/** Why an outcome cannot be recorded on the current scenario (null = it can). */
export function outcomeBlocker(c: CaseRecord, meta: Meta): string | null {
  if (c.source === "dataset") return "Dataset-library patients are already training data; outcomes are recorded only for new cases.";
  const inputs = currentScenario(c).input_snapshot;
  const complete = meta.features.every((f) => f.id in inputs && inputs[f.id] !== null && inputs[f.id] !== meta.unknown_token);
  return complete ? null : "A training example needs every input measured (no Unknown values) on this scenario.";
}

export interface OutcomeInput {
  labels: OutcomeRecord["labels"];
  source_type: OutcomeRecord["source_type"];
  source_system: OutcomeRecord["source_system"];
  pseudonymous_study_id: string | null;
  supersedes_outcome_id: string | null;
  correction_reason: OutcomeRecord["correction_reason"];
}

/** Record a real-world outcome as PENDING, bound to the current immutable scenario (plan §12B rules 1, 1b). */
export async function addOutcome(caseId: string, input: OutcomeInput, meta: Meta): Promise<CaseRecord> {
  return db.transaction("rw", db.cases, async () => {
    const c = await db.cases.get(caseId);
    if (!c) throw new Error("case not found");
    const blocker = outcomeBlocker(c, meta);
    if (blocker) throw new Error(blocker);
    if (input.supersedes_outcome_id && !input.correction_reason) throw new Error("a correction needs a reason");
    const s = currentScenario(c);
    const outcome: OutcomeRecord = {
      outcome_id: uuid(), applies_to_scenario_id: s.scenario_id, applies_to_input_sha256: s.input_sha256,
      analysis_id_at_record: s.current_analysis_id, labels: input.labels,
      label_definition: Object.fromEntries(meta.targets.map((t) => [t.id, t.label_definition])),
      source_type: input.source_type, source_system: input.source_system,
      pseudonymous_study_id: input.pseudonymous_study_id?.trim() || null,
      supersedes_outcome_id: input.supersedes_outcome_id, correction_reason: input.correction_reason,
      outcome_status: "pending", created_at: now(),
    };
    const updated = { ...c, learning_record_id: c.learning_record_id ?? uuid(), outcomes: [...(c.outcomes ?? []), outcome],
                      updated_at: now() };
    await db.cases.put(updated);
    return updated;
  });
}

/** "Export learning package" (plan §12B): allowlisted fields ONLY — no review notes, reviewer identity, free-form
 *  text, timestamps, case/display ids. Every outcome goes out as "pending"; dataset cases are never included. */
export async function exportLearningPackage(): Promise<{ text: string; records: number }> {
  const cases = (await listCases()).filter((c) => c.source !== "dataset" && c.learning_record_id && c.outcomes?.length);
  const records = cases.map((c) => ({
    learning_record_id: c.learning_record_id!, case_source: c.source,
    outcomes: c.outcomes!.map((o) => ({
      outcome_id: o.outcome_id, applies_to_input_sha256: o.applies_to_input_sha256,
      inputs: c.scenarios.find((s) => s.scenario_id === o.applies_to_scenario_id)!.input_snapshot,
      labels: o.labels, label_definition: o.label_definition, source_type: o.source_type,
      source_system: o.source_system, pseudonymous_study_id: o.pseudonymous_study_id,
      supersedes_outcome_id: o.supersedes_outcome_id, correction_reason: o.correction_reason, outcome_status: "pending",
    })),
  }));
  return { text: JSON.stringify({ kind: "novarion_learning_package", package_schema_version: "1.0.0", records }, null, 1),
           records: records.length };
}

async function nextNumber(): Promise<number> {
  const last = await db.cases.orderBy("number").last();
  return (last?.number ?? 0) + 1;
}

function newCase(number: number, source: CaseSource, datasetPatientId: string | null, scenario: Scenario): CaseRecord {
  const t = now();
  return {
    case_id: uuid(), number, display_id: `CASE-${t.slice(0, 4)}-${String(number).padStart(4, "0")}`,
    case_schema_version: CASE_SCHEMA_VERSION, created_at: t, updated_at: t, source,
    dataset_patient_id: datasetPatientId, scenarios: [scenario], reviews: [], snapshots: [],
  };
}

function scenario(analysis: PersistedAnalysis, inputs: Record<string, unknown>, unitStatus: Record<string, string>,
  parent: string | null): Scenario {
  return {
    scenario_id: uuid(), kind: parent ? "edited" : "original", parent_scenario_id: parent, state: "FROZEN",
    input_snapshot: inputs, unit_status: unitStatus, input_sha256: analysis.input_sha256,
    current_analysis_id: analysis.analysis_id, analyses: [analysis], created_at: now(),
  };
}

/** Dataset library patient → a case in OOF mode. The OOF bundle already contains everything (freezes instantly). */
export async function saveDatasetCase(bundle: PatientBundle): Promise<CaseRecord> {
  // Identity vs attachment (plan §1): the case gets its own analysis_id; the OOF result keeps its canonical id.
  const analysis: PersistedAnalysis = { ...bundle, analysis_id: uuid(), stored_at: now() };
  return db.transaction("rw", db.cases, async () => {
    const record = newCase(await nextNumber(), "dataset", bundle.patient_id,
      scenario(analysis, bundle.canonical_inputs, {}, null));
    await db.cases.add(record);
    return record;
  });
}

export interface NewCaseInput {
  inputs: Record<string, InputValue>;
  unitStatus: Record<string, string>;
  canonicalInputs: Record<string, unknown> | null;
  datasetRecordId: number | null;
  source: "manual" | "import";
}

/** New / edited case → ONE /analyze/full call on one bundle handle → stored atomically (all-or-nothing). */
export async function persistNewCase(input: NewCaseInput, appendTo: CaseRecord | null): Promise<CaseRecord> {
  const response = await api.analyzeFull(input.inputs, input.unitStatus, input.datasetRecordId);
  const analysis: PersistedAnalysis = { ...response.data, stored_at: now() };
  const snapshotInputs = input.canonicalInputs ?? input.inputs;
  return db.transaction("rw", db.cases, async () => {
    if (appendTo) {
      const fresh = await db.cases.get(appendTo.case_id);
      if (!fresh) throw new Error("case no longer exists");
      const s = scenario(analysis, snapshotInputs, input.unitStatus, currentScenario(fresh).scenario_id);
      const updated = { ...fresh, scenarios: [...fresh.scenarios, s], updated_at: now() };
      await db.cases.put(updated);
      return updated;
    }
    const record = newCase(await nextNumber(), input.source, null, scenario(analysis, snapshotInputs, input.unitStatus, null));
    await db.cases.add(record);
    return record;
  });
}

export async function addReview(caseId: string, note: string, limitations: string[]): Promise<CaseRecord> {
  return db.transaction("rw", db.cases, async () => {
    const c = await db.cases.get(caseId);
    if (!c) throw new Error("case not found");
    const s = currentScenario(c);
    const review: Review = { review_id: uuid(), scenario_id: s.scenario_id, analysis_id: s.current_analysis_id,
      note, limitations, created_at: now() };
    const updated = { ...c, reviews: [...c.reviews, review], updated_at: now() }; // revisions append, never edit
    await db.cases.put(updated);
    return updated;
  });
}

/** Re-analysis with the current production model (plan §1 state table, §12A.7): a NEW persisted analysis on the
 * SAME scenario; older analyses (and the reviews bound to them) are kept. Dataset cases re-attach the current OOF
 * bundle; other cases run one /analyze/full on the stored inputs. */
export async function reanalyzeCase(caseId: string): Promise<CaseRecord> {
  const c = await db.cases.get(caseId);
  if (!c) throw new Error("case not found");
  const s = currentScenario(c);
  let analysis: PersistedAnalysis;
  if (c.source === "dataset" && c.dataset_patient_id) {
    const bundle = (await api.patient(c.dataset_patient_id)).data;
    analysis = { ...bundle, analysis_id: uuid(), stored_at: now() };
  } else {
    const response = await api.analyzeFull(s.input_snapshot as Record<string, InputValue>, s.unit_status, null);
    analysis = { ...response.data, stored_at: now() };
  }
  return db.transaction("rw", db.cases, async () => {
    const fresh = await db.cases.get(caseId);
    if (!fresh) throw new Error("case no longer exists");
    const scenarios = fresh.scenarios.map((sc) => sc.scenario_id !== s.scenario_id ? sc
      : { ...sc, analyses: [...sc.analyses, analysis], current_analysis_id: analysis.analysis_id });
    const updated = { ...fresh, scenarios, updated_at: now() };
    await db.cases.put(updated);
    return updated;
  });
}

export async function addSnapshot(caseId: string, stored: StoredSnapshot, analysisId: string, scenarioId: string
): Promise<CaseRecord> {
  return db.transaction("rw", db.cases, async () => {
    const c = await db.cases.get(caseId);
    if (!c) throw new Error("case not found");
    const record: SnapshotRecord = { snapshot_id: uuid(), scenario_id: scenarioId, analysis_id: analysisId,
      exported_at: now(), stored_snapshot: stored };
    const updated = { ...c, snapshots: [...c.snapshots, record], updated_at: now() };
    await db.cases.put(updated);
    return updated;
  });
}

export const listCases = () => db.cases.orderBy("number").reverse().toArray();

// Draft recovery: one recoverable draft; it never becomes a scenario implicitly (plan §1).
export const saveDraft = (draft: Omit<DraftRecord, "draft_id" | "saved_at">) =>
  db.drafts.put({ ...draft, draft_id: "current", saved_at: now() });
export const loadDraft = () => db.drafts.get("current");
export const clearDraft = () => db.drafts.delete("current");
export const getCase = (caseId: string) => db.cases.get(caseId);

export interface CaseImportReport {
  imported: string[];
  skipped: string[]; // already present (case_id): never overwritten
  rejected: string[]; // schema mismatch, malformed, or a snapshot whose hash no longer verifies
}

/** Restore exported cases (plan §12A.7 "Cases can be exported/imported as JSON"). Snapshot hashes are re-verified. */
export async function importCases(text: string): Promise<CaseImportReport> {
  const report: CaseImportReport = { imported: [], skipped: [], rejected: [] };
  let doc: { case_schema_version?: string; cases?: CaseRecord[] };
  try {
    doc = JSON.parse(text);
  } catch {
    return { ...report, rejected: ["file is not valid JSON"] };
  }
  if (doc.case_schema_version?.split(".")[0] !== CASE_SCHEMA_VERSION.split(".")[0] || !Array.isArray(doc.cases)) {
    return { ...report, rejected: [`unsupported export (case_schema_version ${doc.case_schema_version ?? "missing"})`] };
  }
  const { verifySnapshot } = await import("./snapshot");
  for (const c of doc.cases) {
    const label = c?.display_id ?? c?.case_id ?? "unknown case";
    const wellFormed = typeof c?.case_id === "string" && Array.isArray(c.scenarios) && c.scenarios.length > 0
      && Array.isArray(c.reviews) && Array.isArray(c.snapshots)
      && c.scenarios.every((s) => Array.isArray(s.analyses) && s.analyses.some((a) => a.analysis_id === s.current_analysis_id));
    if (!wellFormed) {
      report.rejected.push(`${label}: malformed case record`);
      continue;
    }
    const verified = await Promise.all(c.snapshots.map((s) => verifySnapshot(s.stored_snapshot)));
    if (verified.some((ok) => !ok)) {
      report.rejected.push(`${label}: a Review Snapshot hash does not verify (modified after export)`);
      continue;
    }
    await db.transaction("rw", db.cases, async () => {
      if (await db.cases.get(c.case_id)) {
        report.skipped.push(`${label}: already in this browser`);
        return;
      }
      const taken = await db.cases.where("number").equals(c.number).count();
      const number = taken ? await nextNumber() : c.number;
      const display_id = taken ? `CASE-${c.created_at.slice(0, 4)}-${String(number).padStart(4, "0")}` : c.display_id;
      await db.cases.add({ ...c, number, display_id,
        ...(taken ? { imported_from_display_id: c.display_id } : {}) } as CaseRecord);
      report.imported.push(display_id + (taken ? ` (was ${c.display_id})` : ""));
    });
  }
  return report;
}

export async function exportCases(): Promise<string> {
  return JSON.stringify({ case_schema_version: CASE_SCHEMA_VERSION, exported_at: now(), cases: await listCases() },
    null, 1);
}

/** A stored analysis rendered by the same components as a live one (no backend call, plan §1). */
export function toDisplay(a: PersistedAnalysis): DisplayAnalysis {
  return a as unknown as DisplayAnalysis;
}
