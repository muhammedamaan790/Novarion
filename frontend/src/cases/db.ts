// CaseStore (plan §12A "Frontend CaseStore", §11A "Dexie/IndexedDB is the persistence authority").
// Everything stored is immutable once written: a saved analysis is never re-explained, reviews and snapshots are
// append-only records bound to an exact analysis_id, edits create a NEW scenario. The backend stores nothing.
import Dexie, { type Table } from "dexie";
import type { Schemas } from "../api/client";

export const CASE_SCHEMA_VERSION = "1.0.0";

/** A persisted analysis: predictions + all four explanations + evidence from ONE bundle (never re-explained). */
export type PersistedAnalysis = (Schemas["PatientBundle"] | Schemas["AnalyzeFullResponse"]) & { stored_at: string };

export type CaseSource = "dataset" | "manual" | "import";

export interface Scenario {
  scenario_id: string;
  kind: "original" | "edited";
  parent_scenario_id: string | null;
  state: "FROZEN"; // a scenario exists in the store only after its analysis was atomically persisted (plan §1)
  input_snapshot: Record<string, unknown>; // canonical inputs when known, else the submitted inputs
  unit_status: Record<string, string>;
  input_sha256: string; // server-issued
  current_analysis_id: string;
  analyses: PersistedAnalysis[];
  created_at: string;
}

export interface Review {
  review_id: string;
  scenario_id: string;
  analysis_id: string;
  note: string;
  limitations: string[];
  created_at: string;
}

export interface StoredSnapshot {
  snapshot: Record<string, unknown>;
  snapshot_sha256: string;
}

export interface SnapshotRecord {
  snapshot_id: string;
  scenario_id: string;
  analysis_id: string;
  exported_at: string;
  stored_snapshot: StoredSnapshot;
}

export type TargetLabels = Record<"cad" | "lad" | "lcx" | "rca", 0 | 1>;
export const SOURCE_TYPES = ["angiography_report", "catheterization_lab_record", "research_registry"] as const;
export const SOURCE_SYSTEMS = ["hospital_ehr", "research_database", "other_documented"] as const;
export const CORRECTION_REASONS = ["data_entry_error", "updated_source", "label_definition_mismatch"] as const;

/** A recorded real-world outcome (plan §12A CaseStore, §12B rule 1): append-only, bound to one immutable scenario,
 *  and ALWAYS "pending" here — only the steward's offline `make verify-outcomes` can make it training-eligible. */
export interface OutcomeRecord {
  outcome_id: string;
  applies_to_scenario_id: string;
  applies_to_input_sha256: string;
  analysis_id_at_record: string;
  labels: TargetLabels;
  label_definition: Record<string, string>;
  source_type: (typeof SOURCE_TYPES)[number];
  source_system: (typeof SOURCE_SYSTEMS)[number];
  pseudonymous_study_id: string | null;
  supersedes_outcome_id: string | null;
  correction_reason: (typeof CORRECTION_REASONS)[number] | null;
  outcome_status: "pending";
  created_at: string;
}

export interface CaseRecord {
  case_id: string;
  number: number;
  display_id: string; // CASE-2026-0001
  case_schema_version: string;
  created_at: string;
  updated_at: string;
  source: CaseSource;
  dataset_patient_id: string | null;
  scenarios: Scenario[];
  reviews: Review[];
  snapshots: SnapshotRecord[];
  learning_record_id?: string | null; // generated once at the first outcome; immutable; never for dataset cases
  outcomes?: OutcomeRecord[];
}

/** An unsaved new-case draft (plan §1 draft state machine): recoverable only, never part of case history. */
export interface DraftRecord {
  draft_id: "current";
  inputs: Record<string, number | string | null>;
  unit_status: Record<string, string>;
  dataset_record_id: number | null;
  source: "manual" | "import";
  saved_at: string;
}

class NovarionDB extends Dexie {
  cases!: Table<CaseRecord, string>;
  drafts!: Table<DraftRecord, string>;

  constructor() {
    super("novarion");
    this.version(1).stores({ cases: "case_id, number, updated_at" });
    this.version(2).stores({ cases: "case_id, number, updated_at", drafts: "draft_id" }); // additive: no data migration
  }
}

export const db = new NovarionDB();
