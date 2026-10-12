"""Pre-registered promotion gate (plan §12B, §11A "Promotion gate as executable logic"; config/promotion_gate.yaml).

Paired: champion and challenger are scored on the same forward-holdout patients, and every bootstrap replicate draws
patients ONCE and applies the draw to both models.

  evaluable(t)   = holdout_pos ≥ min_positive AND holdout_neg ≥ min_negative
  noninferior(t) = CI95_low(ΔAUC) > −δ AND ΔBrier ≤ 0.01 AND CI95_high(ΔBrier) ≤ 0.03
                   AND CI95(cal_slope_ch) overlaps [0.8, 1.2] AND |obs − mean_pred_ch| ≤ 0.10
  improved(t)    = ΔAUC ≥ 0.01 OR ΔBrier ≤ −0.005
  status = INSUFFICIENT_EVIDENCE if any target not evaluable
           else PASS if all noninferior AND any improved AND tests_pass else FAIL
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np
import yaml
from sklearn.metrics import roc_auc_score

from ..calibrate.platt import calibration_slope_intercept
from ..data.registry import CONFIG_DIR

GATE_YAML = CONFIG_DIR / "promotion_gate.yaml"


def load_gate(path: Path = GATE_YAML) -> dict[str, Any]:
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def _brier(y: np.ndarray, p: np.ndarray) -> float:
    return float(np.mean((p - y) ** 2))


def _ci(values: list[float]) -> list[float]:
    return [float(np.percentile(values, 2.5)), float(np.percentile(values, 97.5))]


def gate_target(target: str, y: np.ndarray, p_champion: np.ndarray, p_challenger: np.ndarray,
                logit_challenger: np.ndarray, gate: dict[str, Any], seed: int) -> dict[str, Any]:
    """One target's gate result, shaped like the API's GateTargetResult (+ diagnostic extras)."""
    y = np.asarray(y, dtype=int)
    n_pos, n_neg = int(y.sum()), int(len(y) - y.sum())
    base = {"n": len(y), "n_positive": n_pos, "n_negative": n_neg}
    if n_pos < gate["min_positive"][target] or n_neg < gate["min_negative"][target]:
        return {"evaluable": False, "auc_champion": None, "auc_challenger": None, "delta_auc_ci95": None,
                "brier_champion": None, "brier_challenger": None, "delta_brier_ci95": None, "cal_slope_ci95": None,
                "rules": {}, **base,
                "note": f"insufficient evidence: {n_pos} positive / {n_neg} negative in the forward holdout "
                        f"(needs {gate['min_positive'][target]} / {gate['min_negative'][target]})"}
    ni, imp, boot = gate["noninferiority"], gate["improvement"], gate["bootstrap"]
    auc_pr, auc_ch = float(roc_auc_score(y, p_champion)), float(roc_auc_score(y, p_challenger))
    br_pr, br_ch = _brier(y, p_champion), _brier(y, p_challenger)
    rng = np.random.default_rng(seed)
    d_auc, d_brier, slopes = [], [], []
    for _ in range(boot["replicates"]):
        idx = rng.integers(0, len(y), len(y))  # one patient draw, applied to BOTH models (paired)
        yb = y[idx]
        if yb.min() == yb.max():
            continue
        d_auc.append(roc_auc_score(yb, p_challenger[idx]) - roc_auc_score(yb, p_champion[idx]))
        d_brier.append(_brier(yb, p_challenger[idx]) - _brier(yb, p_champion[idx]))
        slope, _ = calibration_slope_intercept(logit_challenger[idx], yb)
        if slope is not None and np.isfinite(slope):
            slopes.append(slope)
    need = boot["min_valid_fraction"] * boot["replicates"]
    enough = len(d_auc) >= need
    auc_ci = _ci(d_auc) if enough else None
    brier_ci = _ci(d_brier) if enough else None
    slope_ci = _ci(slopes) if len(slopes) >= need else None  # undefined despite both classes → FAIL (plan §11A)
    lo, hi = ni["cal_slope_overlap"]
    mean_cal_diff = abs(float(y.mean()) - float(np.mean(p_challenger)))
    rules = {
        "delta_auc_ci_low_above_margin": bool(auc_ci is not None and auc_ci[0] > -ni["delta_auc"]),
        "delta_brier_point_ok": (br_ch - br_pr) <= ni["brier_point_max"],
        "delta_brier_ci_high_ok": bool(brier_ci is not None and brier_ci[1] <= ni["brier_ci_high_max"]),
        "cal_slope_ci_overlaps": bool(slope_ci is not None and slope_ci[0] <= hi and slope_ci[1] >= lo),
        "mean_calibration_diff_ok": mean_cal_diff <= ni["mean_calibration_diff_max"],
        "improved": (auc_ch - auc_pr) >= imp["delta_auc_min"] or (br_ch - br_pr) <= imp["delta_brier_max"],
    }
    return {"evaluable": True, "auc_champion": auc_pr, "auc_challenger": auc_ch, "delta_auc_ci95": auc_ci,
            "brier_champion": br_pr, "brier_challenger": br_ch, "delta_brier_ci95": brier_ci,
            "cal_slope_ci95": slope_ci, "rules": rules, **base, "mean_calibration_diff": mean_cal_diff,
            "valid_replicates": len(d_auc)}


def noninferior(result: dict[str, Any]) -> bool:
    return result["evaluable"] and all(v for k, v in result["rules"].items() if k != "improved")


def gate_status(results: dict[str, dict[str, Any]], tests_pass: bool = True) -> str:
    if not all(r["evaluable"] for r in results.values()):
        return "INSUFFICIENT_EVIDENCE"
    if all(noninferior(r) for r in results.values()) and any(r["rules"]["improved"] for r in results.values()):
        return "PASS" if tests_pass else "FAIL"
    return "FAIL"
