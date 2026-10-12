"""OOF-safe stability (refit) bootstrap — plan §6.10a, algorithm B. One (target, outer fold k) per call.

For b = 1..B: S_b = |T_k| rows drawn WITH replacement from fold k's outer-training rows (never from the held-out
fold H_k) → internal 3-fold cross-fitting on S_b, grouped by patient so all bootstrap copies of a patient share one
internal fold → Platt (a_b, b_b) on those cross-fitted logits (a_b ≤ 0 → replicate invalid) → fit the fold's selected
configuration ONCE on all of S_b → predict every held-out patient. Hyperparameters are never re-tuned and t_op_k is
unchanged. Interval per patient = 10th–90th percentile of the valid replicates, shown only with ≥ 80 valid.
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd
from sklearn.model_selection import StratifiedGroupKFold

from ..calibrate.platt import fit_platt, sigmoid
from ..train.config import ModelConfig, TrainConfig, derive_seed
from ..train.models import CandidateModel

MIN_PER_CLASS = 3
MAX_REDRAWS = 10


def _feasible(y: np.ndarray, folds: list[tuple[np.ndarray, np.ndarray]]) -> bool:
    if y.sum() < MIN_PER_CLASS or (len(y) - y.sum()) < MIN_PER_CLASS:
        return False
    return all(y[va].sum() >= MIN_PER_CLASS and (len(va) - y[va].sum()) >= MIN_PER_CLASS for _, va in folds)


def stability_fold(target: str, fold: int, train_ids: np.ndarray, test_ids: np.ndarray, config: ModelConfig,
                   frame: pd.DataFrame, y_all: pd.Series, train: TrainConfig, replicates: int = 100,
                   min_valid: int = 80) -> dict[str, Any]:
    held = {int(i) for i in test_ids}
    assert not held & {int(i) for i in train_ids}, "outer held-out rows must never enter the bootstrap pool"
    f_test = frame.loc[test_ids]
    predictions = np.full((replicates, len(test_ids)), np.nan)
    log = []
    for b in range(replicates):
        seed = derive_seed(train.seeds["BOOTSTRAP_SEED"], target, "stability", fold, b)
        rng = np.random.default_rng(seed)
        status = "invalid: infeasible after redraws"
        for _attempt in range(MAX_REDRAWS):
            sample = rng.choice(train_ids, size=len(train_ids), replace=True)
            y = y_all.loc[sample].to_numpy()
            splitter = StratifiedGroupKFold(n_splits=3, shuffle=True, random_state=seed % (2**31 - 1))
            folds = list(splitter.split(np.zeros(len(sample)), y, groups=sample))  # group = patient id
            if _feasible(y, folds):
                break
        else:
            log.append({"replicate": b, "status": status})
            continue
        frame_s = frame.loc[sample]
        z_cf = np.empty(len(sample))
        for i, (tr, va) in enumerate(folds):
            assert not set(sample[tr]) & set(sample[va]), "bootstrap copies of a patient straddled an internal split"
            model = CandidateModel(config, train, derive_seed(seed, "internal", i)).fit(frame_s.iloc[tr], y[tr])
            z_cf[va] = model.margin(frame_s.iloc[va])
        platt = fit_platt(z_cf, y)  # calibrated only on cross-fitted logits, never in-sample predictions
        if not platt.valid:
            log.append({"replicate": b, "status": f"invalid: platt a = {platt.a:.4g}"})
            continue
        full = CandidateModel(config, train, derive_seed(seed, "full")).fit(frame_s, y)  # the replicate's ONE full fit
        predictions[b] = sigmoid(platt.logit(full.margin(f_test)))
        log.append({"replicate": b, "status": "valid", "a": platt.a, "b": platt.b})
    valid = ~np.isnan(predictions[:, 0])
    out = {}
    for j, rid in enumerate(test_ids):
        p = predictions[valid, j]
        out[int(rid)] = ({"p10": float(np.percentile(p, 10)), "p90": float(np.percentile(p, 90)), "n_valid": int(valid.sum())}
                         if valid.sum() >= min_valid else {"n_valid": int(valid.sum())})
    return {"target": target, "fold": fold, "config_id": config.config_id, "n_valid": int(valid.sum()),
            "replicates": replicates, "intervals": out, "log": log}
