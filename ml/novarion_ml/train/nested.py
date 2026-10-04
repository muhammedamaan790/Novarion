"""Nested cross-validation and the final-model procedure (plan §6.1–6.5, exact procedure §6.4).

For each outer fold (OUTER-TRAIN / OUTER-TEST):
  inner CV over all 92 configurations → per-config inner AUC/Brier + cross-fitted margins on OUTER-TRAIN
  → 1-SE selection, simplest by complexity_rank, with the Platt guard a > 0 (else next eligible, logged)
  → Platt (a, b) on the selected config's cross-fitted margins (inner refits of the selected config)
  → t_op / t_neg / t_pos on the calibrated cross-fitted probabilities
  → refit the selected config on all OUTER-TRAIN → evaluate OUTER-TEST once.
Outer-test results never choose anything. Per-family winners are scored the same way for the benchmark leaderboard.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

import numpy as np
import pandas as pd
from sklearn.metrics import roc_auc_score

from ..calibrate.platt import Platt, fit_platt, sigmoid
from ..thresholds.layers import Thresholds, select_thresholds
from .config import ModelConfig, TrainConfig, derive_seed
from .models import CandidateModel
from .splits import inner_splits


class CalibrationFailure(RuntimeError):
    """No eligible configuration produced a Platt slope a > 0: never silently deployed."""


@dataclass
class InnerResult:
    config: ModelConfig
    aucs: list[float]
    briers: list[float]
    oof_margin: np.ndarray

    @property
    def mean_auc(self) -> float:
        return float(np.mean(self.aucs))

    @property
    def se_auc(self) -> float:
        return float(np.std(self.aucs, ddof=1) / math.sqrt(len(self.aucs)))

    @property
    def mean_brier(self) -> float:
        return float(np.mean(self.briers))

    def summary(self) -> dict[str, Any]:
        return {"config_id": self.config.config_id, "complexity_rank": self.config.complexity_rank,
                "mean_auc": self.mean_auc, "se_auc": self.se_auc, "mean_brier": self.mean_brier}


@dataclass
class Selection:
    config: ModelConfig
    platt: Platt
    oof_margin: np.ndarray  # training-side cross-fitted margins of the selected config
    best_auc: float
    se_best: float
    eligible: list[str]
    guard_log: list[str] = field(default_factory=list)


def inner_cv(target: str, frame: pd.DataFrame, y: np.ndarray, train: TrainConfig, configs: tuple[ModelConfig, ...],
             scope: tuple) -> list[InnerResult]:
    splits = inner_splits(target, y, train, *scope)
    results = []
    for config in configs:
        oof = np.empty(len(y))
        aucs, briers = [], []
        for i, (tr, va) in enumerate(splits):
            seed = derive_seed(train.seeds["TRAIN_SEED"], target, *scope, config.config_id, i)
            model = CandidateModel(config, train, seed).fit(frame.iloc[tr], y[tr])
            z = model.margin(frame.iloc[va])
            oof[va] = z
            aucs.append(float(roc_auc_score(y[va], z)))
            briers.append(float(np.mean((sigmoid(z) - y[va]) ** 2)))
        results.append(InnerResult(config, aucs, briers, oof))
    return results


def select(results: list[InnerResult], y: np.ndarray) -> Selection:
    best = max(results, key=lambda r: (r.mean_auc, -r.config.complexity_rank))
    floor = best.mean_auc - best.se_auc
    eligible = sorted((r for r in results if r.mean_auc >= floor),
                      key=lambda r: (r.config.complexity_rank, r.mean_brier, r.config.config_id))
    log = []
    for r in eligible:
        platt = fit_platt(r.oof_margin, y)
        if platt.valid:
            return Selection(r.config, platt, r.oof_margin, best.mean_auc, best.se_auc,
                             [e.config.config_id for e in eligible], log)
        log.append(f"calibration failed (a={platt.a:.4g}) for {r.config.config_id}; trying next eligible")
    raise CalibrationFailure("; ".join(log))


def thresholds_for(selection: Selection, y: np.ndarray, confidence: dict[str, Any]) -> Thresholds:
    p = selection.platt.prob(selection.oof_margin)
    return select_thresholds(p, y, confidence["target_ppv"], confidence["target_npv"], confidence["n_min_region"])


def _fit_selected(target: str, selection: Selection, frame: pd.DataFrame, y: np.ndarray, train: TrainConfig,
                  scope: tuple) -> CandidateModel:
    seed = derive_seed(train.seeds["TRAIN_SEED"], target, *scope, selection.config.config_id, "refit")
    return CandidateModel(selection.config, train, seed).fit(frame, y).fit_background(frame)


def _scored(model: CandidateModel, selection: Selection, thresholds: Thresholds, frame: pd.DataFrame) -> dict[str, Any]:
    z = model.margin(frame)
    zc = selection.platt.logit(z)
    p = sigmoid(zc)
    return {"margin": z, "cal_logit": zc, "prob": p, "pred": (p >= thresholds.t_op).astype(int),
            "region": [thresholds.region(float(x)) for x in p]}


def run_outer_fold(target: str, repeat: int, fold: int, train_ids: np.ndarray, test_ids: np.ndarray,
                   frame: pd.DataFrame, y_all: pd.Series, train: TrainConfig, confidence: dict[str, Any],
                   keep_model: bool = False) -> dict[str, Any]:
    scope = (repeat, fold)
    f_tr, f_te = frame.loc[train_ids], frame.loc[test_ids]
    y_tr, y_te = y_all.loc[train_ids].to_numpy(), y_all.loc[test_ids].to_numpy()
    results = inner_cv(target, f_tr, y_tr, train, train.configs, scope)

    def evaluate(subset: list[InnerResult]) -> tuple[Selection, Thresholds, CandidateModel, dict[str, Any]]:
        selection = select(subset, y_tr)
        thresholds = thresholds_for(selection, y_tr, confidence)
        model = _fit_selected(target, selection, f_tr, y_tr, train, scope)
        return selection, thresholds, model, _scored(model, selection, thresholds, f_te)

    selection, thresholds, model, scored = evaluate(results)
    benchmarks = {}
    for family in train.raw["family_order"]:
        subset = [r for r in results if r.config.family == family]
        try:
            fsel, fthr, _, fscored = evaluate(subset)  # same rule, restricted to one family (benchmark only)
        except CalibrationFailure as exc:
            benchmarks[family] = {"calibration_failure": str(exc)}
            continue
        benchmarks[family] = {"config_id": fsel.config.config_id, "platt": fsel.platt.to_json(),
                              "thresholds": fthr.to_json(), "test": _jsonable(fscored)}
    out = {
        "target": target, "repeat": repeat, "fold": fold,
        "train_ids": [int(i) for i in train_ids], "test_ids": [int(i) for i in test_ids],
        "y_test": [int(v) for v in y_te],
        "selected": selection.config.config_id, "family": selection.config.family,
        "best_inner_auc": selection.best_auc, "se_best": selection.se_best, "n_eligible": len(selection.eligible),
        "guard_log": selection.guard_log, "platt": selection.platt.to_json(), "thresholds": thresholds.to_json(),
        "test": _jsonable(scored), "inner": [r.summary() for r in results], "benchmarks": benchmarks,
        "dropped_features": model.encoder.dropped_,
    }
    if keep_model:
        out["model"] = model
    return out


def run_final(target: str, frame: pd.DataFrame, y_all: pd.Series, train: TrainConfig, confidence: dict[str, Any]
              ) -> dict[str, Any]:
    """Deployed model: CV-select on all rows → Platt on cross-fitted margins → thresholds → refit on all rows."""
    scope = ("final",)
    y = y_all.loc[frame.index].to_numpy()
    results = inner_cv(target, frame, y, train, train.configs, scope)
    selection = select(results, y)
    thresholds = thresholds_for(selection, y, confidence)
    model = _fit_selected(target, selection, frame, y, train, scope)
    return {
        "target": target, "selected": selection.config.config_id, "family": selection.config.family,
        "best_inner_auc": selection.best_auc, "se_best": selection.se_best, "n_eligible": len(selection.eligible),
        "guard_log": selection.guard_log, "platt": selection.platt, "thresholds": thresholds, "model": model,
        "oof_cal_prob": selection.platt.prob(selection.oof_margin), "inner": [r.summary() for r in results],
    }


def _jsonable(scored: dict[str, Any]) -> dict[str, Any]:
    return {k: (v.tolist() if isinstance(v, np.ndarray) else v) for k, v in scored.items()}
