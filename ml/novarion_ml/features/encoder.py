"""Registry-driven, fold-local feature encoding (plan §5.2).

Input: canonical feature frame (one column per registry feature, canonical values — continuous numbers, binary 0/1,
ordinal/nominal category tokens). UNKNOWNs are imputed by the ReferenceContext *before* encoding.

Fold-local invariant (P0): everything data-dependent (zero-variance removal, scaling) is fit on the training partition
passed to `fit`. Category sets and the log1p list come from the registry (pre-registered), never from data.
Every encoded column keeps its registry feature identity (`origins`) so explanations can be summed back exactly.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from ..data.registry import Feature, Registry, default_registry


def feature_set_ids(feature_set: str, registry: Registry | None = None) -> list[str]:
    registry = registry or default_registry()
    if feature_set == "full":
        return [f.id for f in registry.features]
    if feature_set == "redundancy_reduced":
        return [f.id for f in registry.features if f.in_reduced_feature_set]
    if feature_set.startswith("full_without:"):  # ablation variants only (scripts/ablation.py), never deployed
        group = feature_set.split(":", 1)[1]
        return [f.id for f in registry.features if f.group != group]
    raise ValueError(f"unknown feature set {feature_set!r}")


class RegistryEncoder:
    """Canonical frame → numeric matrix. `linear=True` adds registry log1p + standardization (linear models only)."""

    def __init__(self, feature_ids: list[str], linear: bool, registry: Registry | None = None):
        self.feature_ids = list(feature_ids)
        self.linear = linear
        self.registry = registry or default_registry()

    def _columns(self, feature: Feature, values: pd.Series) -> tuple[list[np.ndarray], list[str]]:
        if feature.kind == "continuous":
            x = values.astype(float).to_numpy()
            if self.linear and feature.log1p:
                x = np.log1p(np.maximum(x, 0.0))
            return [x], [feature.id]
        if feature.kind == "binary":
            return [values.astype(int).to_numpy().astype(float)], [feature.id]
        if feature.kind == "ordinal":
            index = {c: i for i, c in enumerate(feature.categories)}
            return [values.map(index).to_numpy().astype(float)], [feature.id]
        cols = [(values == c).to_numpy().astype(float) for c in feature.categories]  # nominal → one-hot
        return cols, [f"{feature.id}={c}" for c in feature.categories]

    def fit(self, frame: pd.DataFrame) -> RegistryEncoder:
        by_id = self.registry.by_id()
        # fold-local zero-variance removal at registry-feature level (e.g. exertional_chest_pain)
        self.kept_ = [f for f in self.feature_ids if frame[f].nunique(dropna=False) > 1]
        self.dropped_ = [f for f in self.feature_ids if f not in self.kept_]
        self.features_ = [by_id[f] for f in self.kept_]
        raw = self._raw(frame)
        if self.linear:
            self.mean_ = raw.mean(axis=0)
            std = raw.std(axis=0)
            self.scale_ = np.where(std > 0, std, 1.0)
        return self

    def _raw(self, frame: pd.DataFrame) -> np.ndarray:
        columns, names, origins = [], [], []
        for feature in self.features_:
            cols, cnames = self._columns(feature, frame[feature.id])
            columns.extend(cols)
            names.extend(cnames)
            origins.extend([feature.id] * len(cols))
        self.names_, self.origins_ = names, origins
        return np.column_stack(columns)

    def transform(self, frame: pd.DataFrame) -> np.ndarray:
        raw = self._raw(frame)
        return (raw - self.mean_) / self.scale_ if self.linear else raw

    def fit_transform(self, frame: pd.DataFrame) -> np.ndarray:
        return self.fit(frame).transform(frame)
