"""The final-model procedure (plan §6.4) applied to an arbitrary training set — used by candidates, promotion refits
and the replay study. No new ML method: this is `run_final` with an explicit training frame and grid.

- `procedure`: CV selection over the grid → Platt on cross-fitted margins → thresholds → refit, then FREEZE.
- `refit_frozen`: the promotion refit — the SAME frozen configuration only (no re-selection of family,
  hyperparameters or features); Platt + thresholds re-derived from cross-fitted margins of the expanded set.
"""

from __future__ import annotations

import dataclasses
from typing import Any

import numpy as np
import pandas as pd

from ..calibrate.platt import sigmoid
from ..data.registry import load_targets
from ..train.config import ModelConfig, TrainConfig
from ..train.nested import run_final


def restrict(train: TrainConfig, families: list[str] | None) -> TrainConfig:
    if not families:
        return train
    configs = tuple(c for c in train.configs if c.family in families)
    if not configs:
        raise ValueError(f"no configurations for families {families}")
    return dataclasses.replace(train, configs=configs)


def frozen_config(config: ModelConfig, feature_schema_sha256: str, preprocessing_version: str) -> dict[str, Any]:
    return {"config_id": config.config_id, "family": config.family, "params": config.params,
            "feature_set": config.feature_set, "class_weight": config.class_weight,
            "complexity_rank": config.complexity_rank, "feature_schema_sha256": feature_schema_sha256,
            "preprocessing_version": preprocessing_version}


def procedure(target: str, frame: pd.DataFrame, y: pd.Series, train: TrainConfig) -> dict[str, Any]:
    out = run_final(target, frame, y, train, load_targets()["confidence"])
    out["config"] = train.by_id()[out["selected"]]
    return out


def refit_frozen(target: str, frame: pd.DataFrame, y: pd.Series, train: TrainConfig, frozen: dict[str, Any]
                 ) -> dict[str, Any]:
    """Refit exactly the gated configuration. Raises if it is not in the grid (or if its calibration fails)."""
    config = train.by_id().get(frozen["config_id"])
    if config is None or config.family != frozen["family"]:
        raise ValueError(f"frozen config {frozen['config_id']} is not reproducible from train.yaml")
    out = procedure(target, frame, y, dataclasses.replace(train, configs=(config,)))
    assert out["selected"] == frozen["config_id"], "promotion refit must not re-select"
    return out


def score(fitted: dict[str, Any], frame: pd.DataFrame) -> tuple[np.ndarray, np.ndarray]:
    """(probability, calibrated logit) of a procedure output on new rows."""
    logit = fitted["platt"].logit(fitted["model"].margin(frame))
    return sigmoid(logit), logit
