"""Figure data for the Model Evidence page and the report (plan §7 "Figures").

All curves use the pooled OOF predictions of the prespecified outer repeat (each patient exactly once); bands are a
patient-level bootstrap. Training-set predictions are never used.
"""

from __future__ import annotations

from typing import Any

import numpy as np
from sklearn.metrics import precision_recall_curve, roc_curve

FPR_GRID = np.linspace(0, 1, 51)
RECALL_GRID = np.linspace(0, 1, 51)


def _tpr_at(y: np.ndarray, p: np.ndarray) -> np.ndarray:
    fpr, tpr, _ = roc_curve(y, p)
    return np.interp(FPR_GRID, fpr, tpr)


def _precision_at(y: np.ndarray, p: np.ndarray) -> np.ndarray:
    precision, recall, _ = precision_recall_curve(y, p)
    order = np.argsort(recall)  # interp needs increasing x; take the best precision at each recall level
    return np.interp(RECALL_GRID, recall[order], np.maximum.accumulate(precision[order][::-1])[::-1])


def roc_pr(y: np.ndarray, p: np.ndarray, replicates: int, seed: int) -> dict[str, Any]:
    rng = np.random.default_rng(seed)
    tprs, precs = [], []
    for _ in range(replicates):
        idx = rng.integers(0, len(y), len(y))
        if 0 < y[idx].sum() < len(idx):
            tprs.append(_tpr_at(y[idx], p[idx]))
            precs.append(_precision_at(y[idx], p[idx]))
    tprs, precs = np.array(tprs), np.array(precs)
    return {
        "roc": {"fpr": FPR_GRID.round(4).tolist(), "tpr": _tpr_at(y, p).round(4).tolist(),
                "lo": np.percentile(tprs, 2.5, axis=0).round(4).tolist(),
                "hi": np.percentile(tprs, 97.5, axis=0).round(4).tolist()},
        "pr": {"recall": RECALL_GRID.round(4).tolist(), "precision": _precision_at(y, p).round(4).tolist(),
               "lo": np.percentile(precs, 2.5, axis=0).round(4).tolist(),
               "hi": np.percentile(precs, 97.5, axis=0).round(4).tolist(), "prevalence": float(y.mean())},
        "valid_replicates": len(tprs),
    }


def reliability(y: np.ndarray, p: np.ndarray, bins: int, replicates: int, seed: int) -> list[dict[str, Any]]:
    """Quantile bins (plan §6.3: 5 bins) with a bootstrap band on the observed rate per bin."""
    edges = np.quantile(p, np.linspace(0, 1, bins + 1))
    idx = np.clip(np.searchsorted(edges, p, side="right") - 1, 0, bins - 1)
    rng = np.random.default_rng(seed)
    out = []
    for b in range(bins):
        members = np.flatnonzero(idx == b)
        obs = y[members]
        boots = [obs[rng.integers(0, len(obs), len(obs))].mean() for _ in range(replicates)] if len(obs) else []
        out.append({"mean_predicted": float(p[members].mean()), "observed_rate": float(obs.mean()), "n": len(obs),
                    "lo": float(np.percentile(boots, 2.5)) if boots else None,
                    "hi": float(np.percentile(boots, 97.5)) if boots else None})
    return out


def threshold_sweep(y: np.ndarray, p: np.ndarray, points: int = 101) -> list[dict[str, Any]]:
    """PPV of {p ≥ t}, NPV of {p < t} and coverage vs threshold (measured, never inferred)."""
    out = []
    for t in np.linspace(0, 1, points):
        above, below = p >= t, p < t
        out.append({
            "t": round(float(t), 4),
            "ppv": float(y[above].mean()) if above.any() else None,
            "npv": float(1 - y[below].mean()) if below.any() else None,
            "coverage_above": float(above.mean()), "coverage_below": float(below.mean()),
            "n_above": int(above.sum()), "n_below": int(below.sum()),
        })
    return out
