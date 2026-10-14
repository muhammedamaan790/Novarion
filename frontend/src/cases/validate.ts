// Runtime validation of a stored or imported case (audit R10). A case that passes renders without missing parts:
// every analysis carries all four targets with finite values, and every review, snapshot and outcome points at a
// scenario/analysis that exists. Invalid records are reported with a reason and never enter the valid case list.
import type { CaseRecord } from "./db";

const TARGETS = ["cad", "lad", "lcx", "rca"] as const;
const HEX64 = /^[0-9a-f]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isProb = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

function analysisProblem(a: unknown): string | null {
  if (!isObj(a)) return "analysis is not an object";
  if (!isStr(a.analysis_id)) return "analysis without an id";
  if (!isStr(a.model_version)) return `analysis ${a.analysis_id}: no model version`;
  if (typeof a.input_sha256 !== "string" || !HEX64.test(a.input_sha256)) return `analysis ${a.analysis_id}: bad input hash`;
  if (typeof a.artifact_manifest_sha256 !== "string" || !HEX64.test(a.artifact_manifest_sha256)) {
    return `analysis ${a.analysis_id}: bad model artifact hash`;
  }
  if (!isObj(a.patient) || !["oof", "final_model"].includes(a.patient.prediction_mode as string)) {
    return `analysis ${a.analysis_id}: unknown prediction mode`;
  }
  if (!isObj(a.quality)) return `analysis ${a.analysis_id}: no quality report`;
  if (!isObj(a.explanations) || !isObj(a.targets)) return `analysis ${a.analysis_id}: missing predictions or explanations`;
  for (const t of TARGETS) {
    const p = a.targets[t];
    if (!isObj(p)) return `analysis ${a.analysis_id}: no ${t.toUpperCase()} prediction`;
    if (!isProb(p.probability) || !isProb(p.operating_threshold)) return `analysis ${a.analysis_id}: ${t} values out of range`;
    if (!["positive", "negative"].includes(p.predicted_class as string)) return `analysis ${a.analysis_id}: ${t} class unknown`;
    if (!["high", "low"].includes(p.model_confidence as string) || !Array.isArray(p.model_confidence_reasons)) {
      return `analysis ${a.analysis_id}: ${t} confidence unknown`;
    }
  }
  if (typeof a.stored_at !== "string" || !ISO.test(a.stored_at)) return `analysis ${a.analysis_id}: bad timestamp`;
  return null;
}

/** null if the case is complete and consistent, otherwise the first problem found (for the user, not a stack trace). */
export function caseProblem(c: unknown): string | null {
  if (!isObj(c)) return "not a case record";
  const r = c as unknown as CaseRecord;
  if (!isStr(r.case_id) || typeof r.display_id !== "string" || !/^CASE-\d{4}-\d{4}$/.test(r.display_id)) return "bad case id";
  if (!Number.isInteger(r.number) || r.number < 1) return "bad case number";
  if (!isStr(r.case_schema_version)) return "no schema version";
  if (!ISO.test(String(r.created_at)) || !ISO.test(String(r.updated_at))) return "bad timestamps";
  if (!["dataset", "manual", "import"].includes(r.source)) return "unknown source";
  if (r.dataset_patient_id !== null && !/^ZAS-\d{4}$/.test(String(r.dataset_patient_id))) return "bad dataset patient id";
  if (!Array.isArray(r.scenarios) || r.scenarios.length === 0) return "no scenarios";
  if (!Array.isArray(r.reviews) || !Array.isArray(r.snapshots)) return "reviews or snapshots missing";

  const analysesOf = new Map<string, Set<string>>();
  for (const s of r.scenarios) {
    if (!isObj(s) || !isStr(s.scenario_id)) return "scenario without an id";
    if (!["original", "edited"].includes(s.kind) || !isObj(s.input_snapshot) || !isObj(s.unit_status)) {
      return `scenario ${s.scenario_id}: incomplete`;
    }
    if (!Array.isArray(s.analyses) || s.analyses.length === 0) return `scenario ${s.scenario_id}: no analyses`;
    for (const a of s.analyses) {
      const problem = analysisProblem(a);
      if (problem) return problem;
    }
    const ids = new Set(s.analyses.map((a) => a.analysis_id));
    if (!ids.has(s.current_analysis_id)) return `scenario ${s.scenario_id}: current analysis missing`;
    analysesOf.set(s.scenario_id, ids);
  }
  const refersToExisting = (scenarioId: unknown, analysisId: unknown) =>
    typeof scenarioId === "string" && typeof analysisId === "string" && !!analysesOf.get(scenarioId)?.has(analysisId);

  for (const v of r.reviews) {
    if (!isObj(v) || !isStr(v.review_id) || typeof v.note !== "string" || !Array.isArray(v.limitations)) return "malformed review";
    if (!refersToExisting(v.scenario_id, v.analysis_id)) return `review ${v.review_id}: refers to a missing analysis`;
  }
  for (const sn of r.snapshots) {
    if (!isObj(sn) || !isStr(sn.snapshot_id) || !isObj(sn.stored_snapshot) || !isObj(sn.stored_snapshot.snapshot)
        || typeof sn.stored_snapshot.snapshot_sha256 !== "string" || !HEX64.test(sn.stored_snapshot.snapshot_sha256)) {
      return "malformed snapshot";
    }
    if (!refersToExisting(sn.scenario_id, sn.analysis_id)) return `snapshot ${sn.snapshot_id}: refers to a missing analysis`;
  }
  for (const o of r.outcomes ?? []) {
    if (!isObj(o) || !isStr(o.outcome_id) || !isObj(o.labels)) return "malformed outcome";
    if (!TARGETS.every((t) => o.labels[t] === 0 || o.labels[t] === 1)) return `outcome ${o.outcome_id}: labels must be 0 or 1`;
    if (!analysesOf.has(o.applies_to_scenario_id)) return `outcome ${o.outcome_id}: refers to a missing scenario`;
  }
  return null;
}
