"""Platt scaling on the model's raw logit (plan §6.3): z_cal = a·z + b, p = σ(z_cal); guard a > 0."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.optimize import minimize


@dataclass(frozen=True)
class Platt:
    a: float
    b: float

    @property
    def valid(self) -> bool:
        return np.isfinite(self.a) and np.isfinite(self.b) and self.a > 0

    def logit(self, z: np.ndarray) -> np.ndarray:
        return self.a * np.asarray(z, dtype=float) + self.b

    def prob(self, z: np.ndarray) -> np.ndarray:
        return sigmoid(self.logit(z))

    def to_json(self) -> dict:
        return {"method": "platt", "a": self.a, "b": self.b, "space": "raw_logit"}


def sigmoid(x: np.ndarray) -> np.ndarray:
    x = np.asarray(x, dtype=float)
    return np.where(x >= 0, 1 / (1 + np.exp(-np.abs(x))), np.exp(-np.abs(x)) / (1 + np.exp(-np.abs(x))))


def _nll(params: np.ndarray, z: np.ndarray, y: np.ndarray, offset_only: bool = False) -> tuple[float, np.ndarray]:
    a, b = (1.0, params[0]) if offset_only else params
    s = a * z + b
    # log(1 + e^s) − y·s, numerically stable
    loss = np.logaddexp(0, s) - y * s
    r = sigmoid(s) - y
    grad = np.array([r.sum()]) if offset_only else np.array([(r * z).sum(), r.sum()])
    return float(loss.sum()), grad


def fit_platt(z: np.ndarray, y: np.ndarray) -> Platt:
    """Unpenalized 1-D logistic regression of y on z (maximum likelihood)."""
    z, y = np.asarray(z, dtype=float), np.asarray(y, dtype=float)
    if not _estimable(z, y):
        return Platt(float("nan"), float("nan"))
    res = minimize(_nll, x0=np.array([1.0, 0.0]), args=(z, y), jac=True, method="L-BFGS-B")
    if not res.success or not np.isfinite(res.x).all():
        return Platt(float("nan"), float("nan"))
    return Platt(float(res.x[0]), float(res.x[1]))


def _estimable(z: np.ndarray, y: np.ndarray) -> bool:
    """A finite identifiable two-parameter MLE needs overlapping classes and varying margins."""
    if z.ndim != 1 or y.shape != z.shape or not len(z) or not np.isfinite(z).all():
        return False
    if not np.isin(y, [0, 1]).all() or not (y == 0).any() or not (y == 1).any():
        return False
    if np.ptp(z) == 0:
        return False
    neg, pos = z[y == 0], z[y == 1]
    # Equality detects quasi-complete separation: shared boundary scores still have no finite slope MLE.
    return not (pos.min() >= neg.max() or neg.min() >= pos.max())


def calibration_slope_intercept(cal_logit: np.ndarray, y: np.ndarray) -> tuple[float | None, float | None]:
    """Evaluation fits (plan §6.3): slope β from free recalibration on the calibrated logit; α_CL with slope fixed
    at 1 (offset). Returns None (reported as NA, never 0) when undefined (one class, or separation)."""
    y = np.asarray(y, dtype=float)
    if y.min() == y.max():
        return None, None
    z = np.asarray(cal_logit, dtype=float)
    free = (minimize(_nll, x0=np.array([1.0, 0.0]), args=(z, y), jac=True, method="L-BFGS-B")
            if _estimable(z, y) else None)
    offset = minimize(_nll, x0=np.array([0.0]), args=(z, y, True), jac=True, method="L-BFGS-B")
    slope = float(free.x[0]) if free is not None and free.success and np.isfinite(free.x).all() else None
    intercept = float(offset.x[0]) if offset.success and abs(offset.x[0]) < 1e3 else None
    return slope, intercept
