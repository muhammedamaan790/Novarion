// All user-facing safety wording in one place (plan §12, §20, D-008). Never "diagnosis", "risk of", "you have".
import type { TargetId, TargetPrediction } from "../api/client";

export const DISCLAIMER =
  "Decision support / educational purposes only. Not a substitute for formal diagnostic imaging.";

export const SHORT: Record<TargetId, string> = { cad: "CAD", lad: "LAD", lcx: "LCX", rca: "RCA" };

export function predictionText(target: TargetId, p: TargetPrediction): string {
  const positive = p.predicted_class === "positive";
  if (target === "cad") return positive ? "CAD PREDICTED" : "NO CAD PREDICTED";
  return positive ? "STENOSIS PREDICTED" : "NO STENOSIS PREDICTED";
}

export function subtitle(target: TargetId): string {
  return target === "cad"
    ? "model estimate of the dataset's CAD label"
    : `model estimate of the dataset's ≥50% ${SHORT[target]} stenosis label`;
}

export function probabilityLabel(target: TargetId): string {
  return target === "cad" ? "Overall CAD probability" : `${SHORT[target]} stenosis-label probability`;
}

// Only the UI rounds (contract rule). `pct` = observed rates and band edges (can truly be 0% / 100%).
export const pct = (p: number) => `${Math.round(p * 100)}%`;
// Model probabilities are never shown as 0% or 100%: an estimate is never certain (plan §12, no false precision).
export const probPct = (p: number) => (p >= 0.995 ? ">99%" : p < 0.005 ? "<1%" : `${Math.round(p * 100)}%`);

export const REASON_TEXT: Record<string, string> = {
  unknown_input: "an input was marked UNKNOWN",
  atypical_profile: "atypical profile compared with the reference cohort",
  unstable: "the model is unstable for this patient",
  no_qualified_region: "no qualified high-confidence region for this target",
  gray_zone: "near the operating threshold",
};

export const TOOLTIPS = {
  independence: "Targets are estimated independently; probabilities are not constrained to sum or nest.",
  overallCad:
    "The hackathon brief calls this 'overall cardiac risk'; this prototype operationalizes it as the calibrated " +
    "probability of the dataset's CAD label. It isn't a clinically validated cardiovascular risk score.",
  vessel:
    "Predicted probability of the dataset-defined stenosis label for this vessel. Location within the vessel is not known.",
  confidence: "Confidence reflects validation performance in this dataset/cohort; it isn't clinical certainty.",
  legend:
    "Colour family = predicted class; colour depth = how far the probability is from the decision threshold. " +
    "The probability is shown as a number.",
  how: "Which measured input groups were associated with the model output for this target.",
};

export const MODE_BADGE: Record<string, string> = {
  oof: "OOF VALIDATION",
  final_model: "FINAL PRODUCTION MODEL",
};
