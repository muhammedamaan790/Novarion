"""Evaluation (plan §7): Table 1 (Layer A, per outer fold → mean ± SD), baselines, Table 2 (confidence tiers, one
complete outer repeat, patient-level bootstrap CIs). Undefined metrics are NA (None), never 0.
"""

from __future__ import annotations

from typing import Any

import numpy as np
from sklearn.metrics import average_precision_score, roc_auc_score

from ..calibrate.platt import calibration_slope_intercept

TABLE1_METRICS = ["roc_auc", "pr_auc", "accuracy", "balanced_accuracy", "precision", "recall", "f1", "specificity",
                  "npv", "brier", "brier_skill", "cal_slope", "cal_intercept"]


def _ratio(num: float, den: float) -> float | None:
    return None if den == 0 else num / den


def classification(y: np.ndarray, pred: np.ndarray) -> dict[str, float | None]:
    y, pred = np.asarray(y, dtype=int), np.asarray(pred, dtype=int)
    tp = int(((pred == 1) & (y == 1)).sum())
    tn = int(((pred == 0) & (y == 0)).sum())
    fp = int(((pred == 1) & (y == 0)).sum())
    fn = int(((pred == 0) & (y == 1)).sum())
    recall, spec = _ratio(tp, tp + fn), _ratio(tn, tn + fp)
    return {
        "accuracy": (tp + tn) / len(y),
        "balanced_accuracy": None if recall is None or spec is None else (recall + spec) / 2,
        "precision": _ratio(tp, tp + fp), "recall": recall, "specificity": spec, "npv": _ratio(tn, tn + fn),
        "f1": _ratio(2 * tp, 2 * tp + fp + fn), "tp": tp, "tn": tn, "fp": fp, "fn": fn,
    }


def fold_metrics(y: np.ndarray, prob: np.ndarray, cal_logit: np.ndarray, pred: np.ndarray) -> dict[str, Any]:
    y = np.asarray(y, dtype=int)
    prob = np.asarray(prob, dtype=float)
    out: dict[str, Any] = classification(y, pred)
    both = 0 < y.sum() < len(y)
    out["roc_auc"] = float(roc_auc_score(y, prob)) if both else None
    out["pr_auc"] = float(average_precision_score(y, prob)) if both else None
    brier = float(np.mean((prob - y) ** 2))
    prev = y.mean()
    brier_prior = prev * (1 - prev)  # prior predictor computed on the same evaluation fold (plan §11A)
    out["brier"] = brier
    out["brier_skill"] = None if brier_prior == 0 else 1 - brier / brier_prior
    out["cal_slope"], out["cal_intercept"] = calibration_slope_intercept(cal_logit, y)
    return out


def baseline_metrics(y_test: np.ndarray, train_prevalence: float) -> dict[str, dict[str, Any]]:
    y = np.asarray(y_test, dtype=int)
    prev = float(y.mean())
    prior_p = np.full(len(y), train_prevalence)
    return {
        "always_negative": classification(y, np.zeros(len(y), dtype=int)),
        "always_positive": classification(y, np.ones(len(y), dtype=int)),
        "prior": {"roc_auc": None, "pr_auc": prev, "brier": float(np.mean((prior_p - y) ** 2)),
                  "brier_skill": None if prev in (0, 1) else 1 - float(np.mean((prior_p - y) ** 2)) / (prev * (1 - prev))},
    }


def summarize(folds: list[dict[str, Any]], metrics: list[str] = TABLE1_METRICS) -> dict[str, dict[str, Any]]:
    out = {}
    for m in metrics:
        values = [f.get(m) for f in folds]
        defined = [float(v) for v in values if v is not None]
        out[m] = {
            "mean": float(np.mean(defined)) if defined else None,
            "sd": float(np.std(defined, ddof=1)) if len(defined) > 1 else None,
            "n_defined": len(defined), "n_na": len(values) - len(defined),
        }
    return out


def percentile_ci(values: list[float], n_total: int, min_valid: int) -> list[float] | None:
    if len(values) < min_valid:
        return None
    lo, hi = np.percentile(values, [2.5, 97.5])
    return [float(lo), float(hi)]


def confidence_table(y: np.ndarray, prob: np.ndarray, pred: np.ndarray, region: list[str], replicates: int,
                     min_valid: int, seed: int) -> dict[str, Any]:
    """Table 2 on one complete outer repeat (each patient exactly once), metric-CI bootstrap over patients."""
    y, prob, pred = np.asarray(y, dtype=int), np.asarray(prob, dtype=float), np.asarray(pred, dtype=int)
    region = np.asarray(region)

    def stats(idx: np.ndarray) -> dict[str, float | None]:
        yy, rr, pp = y[idx], region[idx], pred[idx]
        hp, hn = rr == "high_positive", rr == "high_negative"
        high = hp | hn
        return {
            "pct_high_positive": float(hp.mean()), "pct_high_negative": float(hn.mean()),
            "pct_low_confidence": float(1 - high.mean()),
            "ppv": _ratio(int((yy[hp] == 1).sum()), int(hp.sum())),
            "npv": _ratio(int((yy[hn] == 0).sum()), int(hn.sum())),
            "accuracy_high_confidence": _ratio(int((pp[high] == yy[high]).sum()), int(high.sum())),
            "auc": float(roc_auc_score(yy, prob[idx])) if 0 < yy.sum() < len(yy) else None,
        }

    point = stats(np.arange(len(y)))
    rng = np.random.default_rng(seed)
    boots: dict[str, list[float]] = {k: [] for k in ("ppv", "npv", "auc")}
    for _ in range(replicates):
        s = stats(rng.integers(0, len(y), len(y)))
        for k, values in boots.items():
            if s[k] is not None:  # undefined replicates are excluded from THAT metric's CI (plan §11A)
                values.append(s[k])
    hp, hn = region == "high_positive", region == "high_negative"
    return {
        **point,
        "n": len(y), "n_high_positive": int(hp.sum()), "n_high_negative": int(hn.sum()),
        "ppv_ci": percentile_ci(boots["ppv"], replicates, min_valid),
        "npv_ci": percentile_ci(boots["npv"], replicates, min_valid),
        "auc_ci": percentile_ci(boots["auc"], replicates, min_valid),
        "valid_replicates": {k: len(v) for k, v in boots.items()},
        "fn_high_negative": int(((y == 1) & hn).sum()), "fp_high_positive": int(((y == 0) & hp).sum()),
    }
