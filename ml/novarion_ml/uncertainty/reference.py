"""ReferenceContext (plan §6.11): one object per reference partition; no tier-2 feature builds its own reference.

  imputation         median (continuous, rounded to canonical precision) / mode (other kinds) — for explicit UNKNOWN
  observed range     [min, max] (continuous / ordinal) or the set of seen categories (binary / nominal)
  Gower kNN          equal-weight Gower over registry features (range-normalized |Δ| for continuous / ordinal,
                     0/1 mismatch for binary / nominal; UNKNOWN query fields excluded from numerator and denominator);
                     k_eff = min(10, n); ties by dataset_record_id
  atypical           mean distance to the k nearest → percentile of the stored leave-one-out distribution;
                     cutoff = 95th percentile
  cohort comparisons per target: percentile in target-neg vs target-pos (continuous / ordinal) or the prevalence of
                     the value (binary / nominal); n < n_min_compare → insufficient evidence
  evidence ledger    positive-label rate among OOF predictions of the reference patients in the pre-registered band

Dataset patient (OOF): the reference is that patient's fold outer-training rows only. New patient: all 303.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
import pandas as pd

from ..data.canonical import round_canonical
from ..data.registry import Registry, default_registry

K_NEIGHBOURS = 10
ATYPICAL_PERCENTILE = 95


@dataclass
class Ledger:
    probs: np.ndarray
    labels: np.ndarray


class ReferenceContext:
    def __init__(self, frame: pd.DataFrame, labels: pd.DataFrame, ledgers: dict[str, Ledger], scope: str,
                 n_min_compare: int, evidence_bands: list[list[float]], band_min_n: int,
                 registry: Registry | None = None):
        registry = registry or default_registry()
        self.scope = scope
        self.ids = frame.index.to_numpy()
        self.frame = frame
        self.labels = labels.loc[frame.index]
        self.ledgers = ledgers
        self.n_min_compare = n_min_compare
        self.evidence_bands = evidence_bands
        self.band_min_n = band_min_n
        self.features = list(registry.features)
        self.unknown = registry.unknown_token
        self.imputation: dict[str, Any] = {}
        self.observed: dict[str, Any] = {}
        self._numeric_cols: list[int] = []
        self._ranges: list[float] = []
        for j, f in enumerate(self.features):
            col = frame[f.id]
            if f.kind == "continuous":
                self.imputation[f.id] = round_canonical(float(col.median()), f.canonical_precision or 0)
                self.observed[f.id] = [float(col.min()), float(col.max())]
            else:
                counts = col.value_counts()
                top = counts[counts == counts.max()].index
                order = list(f.categories) if f.kind != "binary" else [0, 1]
                self.imputation[f.id] = _py(min(top, key=lambda v: order.index(v) if v in order else 99))  # ties: registry order
                self.observed[f.id] = sorted({_py(v) for v in col.unique()}, key=str)
            if f.kind in ("continuous", "ordinal"):
                self._numeric_cols.append(j)
        self._matrix = self._encode_rows(frame)
        self._ranges = np.array([np.ptp(self._matrix[:, j]) if j in self._numeric_cols else 1.0
                                 for j in range(len(self.features))])
        self._loo = np.sort(self._loo_distribution())
        self.atypical_cutoff = float(np.percentile(self._loo, ATYPICAL_PERCENTILE))

    # ------------------------------------------------------------------------------------------------ encoding
    def _code(self, f, value) -> float:
        if value == self.unknown:
            return np.nan
        if f.kind == "continuous":
            return float(value)
        if f.kind == "binary":
            return float(value)
        return float(list(f.categories).index(value))

    def _encode_rows(self, frame: pd.DataFrame) -> np.ndarray:
        return np.column_stack([frame[f.id].map(lambda v, f=f: self._code(f, v)).to_numpy(dtype=float)
                                for f in self.features])

    def encode(self, canonical: dict[str, Any]) -> np.ndarray:
        return np.array([self._code(f, canonical[f.id]) for f in self.features], dtype=float)

    # ------------------------------------------------------------------------------------------------ gower
    def _distances(self, q: np.ndarray, rows: np.ndarray) -> np.ndarray:
        known = ~np.isnan(q)
        diff = np.zeros_like(rows)
        numeric = np.zeros(len(self.features), dtype=bool)
        numeric[self._numeric_cols] = True
        with np.errstate(invalid="ignore", divide="ignore"):
            num = np.abs(rows - q) / np.where(self._ranges > 0, self._ranges, 1.0)
        num[:, self._ranges == 0] = 0.0  # a feature with range 0 contributes 0 (plan §11A)
        diff[:, numeric] = num[:, numeric]
        diff[:, ~numeric] = (rows[:, ~numeric] != q[~numeric]).astype(float)
        return diff[:, known].sum(axis=1) / max(1, known.sum())

    def neighbours(self, canonical: dict[str, Any], exclude_id: int | None = None) -> list[tuple[int, float]]:
        d = self._distances(self.encode(canonical), self._matrix)
        order = sorted(((float(dist), int(rid)) for dist, rid in zip(d, self.ids, strict=True) if rid != exclude_id))
        k = min(K_NEIGHBOURS, len(order))
        return [(rid, dist) for dist, rid in order[:k]]

    def _loo_distribution(self) -> np.ndarray:
        out = np.empty(len(self.ids))
        for i in range(len(self.ids)):
            d = self._distances(self._matrix[i], self._matrix)
            d[i] = np.inf
            k = min(K_NEIGHBOURS, len(d) - 1)
            out[i] = np.sort(d)[:k].mean()
        return out

    def atypical(self, canonical: dict[str, Any]) -> dict[str, Any]:
        nn = self.neighbours(canonical)
        mean_d = float(np.mean([d for _, d in nn]))
        percentile = float(100.0 * np.searchsorted(self._loo, mean_d, side="right") / len(self._loo))
        outside = self.outside_observed(canonical)
        return {
            "flag": bool(mean_d > self.atypical_cutoff or outside),
            "distance_percentile": round(percentile, 1),
            "mean_distance": mean_d,
            "outside_observed_range": outside,
            "excluded_unknown_features": [f.id for f in self.features if canonical[f.id] == self.unknown],
        }

    def outside_observed(self, canonical: dict[str, Any]) -> list[str]:
        out = []
        for f in self.features:
            v = canonical[f.id]
            if v == self.unknown:
                continue
            seen = self.observed[f.id]
            if f.kind == "continuous" and not seen[0] <= v <= seen[1] or f.kind != "continuous" and _py(v) not in seen:
                out.append(f.id)
        return out

    # ------------------------------------------------------------------------------------------------ imputation
    def impute(self, canonical: dict[str, Any]) -> dict[str, Any]:
        return {k: (self.imputation[k] if v == self.unknown else v) for k, v in canonical.items()}

    # ------------------------------------------------------------------------------------------------ comparisons
    def comparison(self, target: str, feature_id: str, value: Any) -> dict[str, Any]:
        f = next(x for x in self.features if x.id == feature_id)
        y = self.labels[target].to_numpy()
        col = self.frame[feature_id]
        sides = {}
        for side, mask in (("negative", y == 0), ("positive", y == 1)):
            sub = col.to_numpy()[mask]
            n = int(mask.sum())
            if n < self.n_min_compare:
                sides[side] = {"n": n, "status": "insufficient_evidence"}
                continue
            if f.kind in ("continuous", "ordinal"):
                if f.kind == "ordinal":
                    idx = {c: i for i, c in enumerate(f.categories)}
                    sub, v = np.array([idx[s] for s in sub], dtype=float), float(idx[value])
                else:
                    sub, v = sub.astype(float), float(value)
                pct = 100.0 * ((sub < v).sum() + 0.5 * (sub == v).sum()) / n
                sides[side] = {"n": n, "status": "ok", "percentile": round(float(pct), 1)}
            else:
                sides[side] = {"n": n, "status": "ok", "rate": round(float(np.mean(sub == value)), 4)}
        kind = "percentile" if f.kind in ("continuous", "ordinal") else (
            "binary_prevalence" if f.kind == "binary" else "category_frequency")
        return {"type": kind, "value": _py(value), **sides}

    # ------------------------------------------------------------------------------------------------ ledger
    def band(self, p: float) -> list[float]:
        for lo, hi in self.evidence_bands:
            if lo <= p < hi or (hi == 1.0 and p == 1.0):
                return [lo, hi]
        raise ValueError(f"probability {p} outside [0, 1]")

    def ledger(self, target: str, p: float) -> dict[str, Any]:
        lo, hi = self.band(p)
        led = self.ledgers[target]
        in_band = (led.probs >= lo) & ((led.probs < hi) | ((hi == 1.0) & (led.probs <= 1.0)))
        n = int(in_band.sum())
        ok = n >= self.band_min_n
        return {"band": [lo, hi], "status": "ok" if ok else "insufficient_evidence", "n": n,
                "positive_label_rate": round(float(led.labels[in_band].mean()), 4) if ok else None}

    def similar(self, canonical: dict[str, Any], patient_id_of, exclude_id: int | None = None) -> list[dict[str, Any]]:
        out = []
        for rank, (rid, dist) in enumerate(self.neighbours(canonical, exclude_id), start=1):
            row = self.frame.loc[rid]
            out.append({
                "patient_id": patient_id_of(rid), "rank": rank, "distance": dist,  # unrounded: order = (distance, id)
                "labels": {t: int(self.labels.loc[rid, t]) for t in self.labels.columns},
                "summary": {"age": _py(row["age"]), "sex": "male" if _py(row["sex"]) == 1 else "female"},
            })
        return out


def _py(v: Any) -> Any:
    return v.item() if hasattr(v, "item") else v
