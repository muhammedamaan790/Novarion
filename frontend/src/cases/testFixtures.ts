// Test-only: a complete, valid stored analysis (all four targets, hashes, explanations), so case fixtures exercise the
// real validation rules instead of slipping past them (audit R10).
import type { PersistedAnalysis } from "./db";

export function completeAnalysis(analysisId: string, modelVersion = "1.0.2"): PersistedAnalysis {
  const target = (probability: number) => ({
    probability, operating_threshold: 0.5, predicted_class: probability >= 0.5 ? "positive" : "negative",
    model_confidence: "low", model_confidence_reasons: ["no_qualified_region"],
  });
  return {
    analysis_id: analysisId, model_version: modelVersion, input_sha256: "a".repeat(64), artifact_manifest_sha256: "b".repeat(64),
    patient: { prediction_mode: "final_model" }, quality: { status: "ok" },
    targets: { cad: target(0.8), lad: target(0.6), lcx: target(0.3), rca: target(0.2) },
    explanations: {}, evidence: {}, stored_at: "2026-10-12T00:00:00Z",
  } as unknown as PersistedAnalysis;
}
