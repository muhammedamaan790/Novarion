"""Layer A (official binary prediction) and Layer B (confidence regions) thresholds (plan §6.5).

All thresholds are chosen on calibrated OOF probabilities of the TRAINING side only. Prediction rule: p ≥ t → positive.
  t_op  = Youden's J; ties → closest to 0.5, then the lower threshold.
  t_neg = highest candidate ≤ t_op whose below-region {p < t} has n ≥ n_min and Wilson-95% LB(NPV) ≥ target_npv.
  t_pos = lowest  candidate ≥ t_op whose above-region {p ≥ t} has n ≥ n_min and Wilson-95% LB(PPV) ≥ target_ppv.
No post-hoc clamping: if no candidate qualifies, that region does not exist (None).
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

WILSON_Z = 1.959963984540054


def wilson_lower(successes: int, n: int, z: float = WILSON_Z) -> float:
    if n == 0:
        return 0.0
    p = successes / n
    denom = 1 + z * z / n
    centre = p + z * z / (2 * n)
    margin = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return (centre - margin) / denom


@dataclass(frozen=True)
class Qualification:
    metric: str  # "ppv" | "npv"
    target: float
    lower_bound: float
    n: int
    value: float


@dataclass(frozen=True)
class Thresholds:
    t_op: float
    t_neg: float | None
    t_pos: float | None
    q_neg: Qualification | None
    q_pos: Qualification | None

    def region(self, p: float) -> str:
        if self.t_pos is not None and p >= self.t_pos:
            return "high_positive"
        if self.t_neg is not None and p < self.t_neg:
            return "high_negative"
        return "low_confidence"

    def to_json(self) -> dict:
        def q(x: Qualification | None):
            return None if x is None else x.__dict__.copy()

        return {"t_op": self.t_op, "t_neg": self.t_neg, "t_pos": self.t_pos,
                "qualification_negative": q(self.q_neg), "qualification_positive": q(self.q_pos),
                "selection_rule": "t_op=Youden J; t_neg/t_pos=Wilson-95% LB of NPV/PPV >= target with n >= n_min"}


def candidates(p: np.ndarray) -> np.ndarray:
    return np.unique(np.concatenate([[0.0, 1.0], np.asarray(p, dtype=float)]))


def youden_threshold(p: np.ndarray, y: np.ndarray) -> float:
    p, y = np.asarray(p, dtype=float), np.asarray(y, dtype=int)
    n_pos, n_neg = y.sum(), len(y) - y.sum()
    best_key, best_t = None, 0.5
    for t in candidates(p):
        pred = p >= t
        j = (pred & (y == 1)).sum() / n_pos + (~pred & (y == 0)).sum() / n_neg - 1
        key = (-round(j, 12), abs(t - 0.5), t)  # max J → closest to 0.5 → lower
        if best_key is None or key < best_key:
            best_key, best_t = key, float(t)
    return best_t


def select_thresholds(p: np.ndarray, y: np.ndarray, target_ppv: float, target_npv: float, n_min: int) -> Thresholds:
    p, y = np.asarray(p, dtype=float), np.asarray(y, dtype=int)
    t_op = youden_threshold(p, y)
    grid = candidates(p)
    t_neg = q_neg = None
    for t in sorted((c for c in grid if c <= t_op), reverse=True):  # highest qualifying ≤ t_op
        below = p < t
        n = int(below.sum())
        if n >= n_min:
            tn = int((below & (y == 0)).sum())
            lb = wilson_lower(tn, n)
            if lb >= target_npv:
                t_neg, q_neg = float(t), Qualification("npv", target_npv, lb, n, tn / n)
                break
    t_pos = q_pos = None
    for t in sorted(c for c in grid if c >= t_op):  # lowest qualifying ≥ t_op
        above = p >= t
        n = int(above.sum())
        if n >= n_min:
            tp = int((above & (y == 1)).sum())
            lb = wilson_lower(tp, n)
            if lb >= target_ppv:
                t_pos, q_pos = float(t), Qualification("ppv", target_ppv, lb, n, tp / n)
                break
    return Thresholds(t_op, t_neg, t_pos, q_neg, q_pos)
