"""One fitted candidate = registry encoder + estimator (plan §6.1–6.2).

Uniform interface for the 4 deployable families: `fit(frame, y)`, `margin(frame)` (raw log-odds, the space Platt and
the explanations live in) and `raw_contributions(frame)` (per encoded column, additive: base + Σ = margin, exactly).
One class-weight policy for all families: `balanced` → w_pos = n/(2·n_pos), w_neg = n/(2·n_neg) from the partition
being fit, passed as `sample_weight` (never family-specific APIs).
"""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from ..features.encoder import RegistryEncoder, feature_set_ids
from .config import ModelConfig, TrainConfig

LINEAR_FAMILIES = {"lr"}


def balanced_weights(y: np.ndarray) -> np.ndarray:
    n, n_pos = len(y), int(y.sum())
    n_neg = n - n_pos
    return np.where(y == 1, n / (2 * n_pos), n / (2 * n_neg))


def make_estimator(config: ModelConfig, train: TrainConfig, seed: int):
    fixed = train.raw["families"][config.family]["fixed"]
    p = config.params
    if config.family == "lr":
        from sklearn.linear_model import LogisticRegression

        kwargs = {"l1_ratio": fixed["l1_ratio_elasticnet"]} if p["penalty"] == "elasticnet" else {}
        return LogisticRegression(penalty=p["penalty"], C=p["C"], solver=fixed["solver"], max_iter=fixed["max_iter"],
                                  tol=fixed["tol"], random_state=seed, **kwargs)
    if config.family == "xgboost":
        from xgboost import XGBClassifier

        return XGBClassifier(max_depth=p["max_depth"], n_estimators=p["n_estimators"], learning_rate=fixed["learning_rate"],
                             subsample=fixed["subsample"], colsample_bytree=fixed["colsample_bytree"],
                             min_child_weight=fixed["min_child_weight"], reg_lambda=fixed["reg_lambda"],
                             objective=fixed["objective"], eval_metric=fixed["eval_metric"],
                             tree_method=fixed["tree_method"], n_jobs=1, random_state=seed)
    if config.family == "catboost":
        from catboost import CatBoostClassifier

        return CatBoostClassifier(depth=p["depth"], iterations=p["iterations"], learning_rate=fixed["learning_rate"],
                                  l2_leaf_reg=fixed["l2_leaf_reg"], loss_function=fixed["loss_function"],
                                  thread_count=1, verbose=0, random_seed=seed, allow_writing_files=False)
    if config.family == "ebm":
        from interpret.glassbox import ExplainableBoostingClassifier

        return ExplainableBoostingClassifier(interactions=fixed["interactions"], max_bins=p["max_bins"],
                                             outer_bags=fixed["outer_bags"], inner_bags=fixed["inner_bags"],
                                             learning_rate=fixed["learning_rate"], n_jobs=1, random_state=seed)
    raise ValueError(config.family)


class CandidateModel:
    def __init__(self, config: ModelConfig, train: TrainConfig, seed: int):
        self.config = config
        self.seed = seed
        self.encoder = RegistryEncoder(feature_set_ids(config.feature_set), linear=config.family in LINEAR_FAMILIES)
        self.estimator = make_estimator(config, train, seed)

    def fit(self, frame: pd.DataFrame, y: np.ndarray) -> CandidateModel:
        X = self.encoder.fit_transform(frame)
        weights = balanced_weights(y) if self.config.class_weight == "balanced" else np.ones(len(y))
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")  # saga convergence chatter at extreme C is expected and logged by metrics
            self.estimator.fit(X, y, sample_weight=weights)
        return self

    def margin(self, frame: pd.DataFrame) -> np.ndarray:
        X = self.encoder.transform(frame)
        family = self.config.family
        if family == "lr":
            return self.estimator.decision_function(X)
        if family == "xgboost":
            return self.estimator.predict(X, output_margin=True).astype(float)
        if family == "catboost":
            return np.asarray(self.estimator.predict(X, prediction_type="RawFormulaVal"), dtype=float)
        return np.asarray(self.estimator.decision_function(X), dtype=float)  # ebm

    def raw_contributions(self, frame: pd.DataFrame) -> tuple[np.ndarray, np.ndarray]:
        """(base[n], contributions[n, encoded_columns]) in raw margin space with base + Σ = margin (exact).

        LR: interventional linear SHAP with the training partition as background (encoded mean = 0 after
        standardization, so base = intercept). XGBoost / CatBoost: native TreeSHAP (path-dependent, exact,
        includes the bias term). EBM (interactions = 0): native additive term scores + intercept.
        """
        X = self.encoder.transform(frame)
        family = self.config.family
        if family == "lr":
            coef = self.estimator.coef_[0]
            centre = self.encoder_train_mean_
            contrib = (X - centre) * coef
            base = np.full(len(X), float(self.estimator.intercept_[0] + centre @ coef))
            return base, contrib
        if family == "xgboost":
            import xgboost as xgb

            out = self.estimator.get_booster().predict(xgb.DMatrix(X), pred_contribs=True)
            return out[:, -1].astype(float), out[:, :-1].astype(float)
        if family == "catboost":
            from catboost import Pool

            out = self.estimator.get_feature_importance(Pool(X), type="ShapValues")
            return out[:, -1].astype(float), out[:, :-1].astype(float)
        scores = self.estimator.eval_terms(X)  # (n, n_terms); interactions = 0 → one term per encoded column
        return np.full(len(X), float(self.estimator.intercept_[0] if np.ndim(self.estimator.intercept_) else
                                     self.estimator.intercept_)), np.asarray(scores, dtype=float)

    def fit_background(self, frame: pd.DataFrame) -> CandidateModel:
        """Store the encoded mean of the explanation background (LR only; trees/EBM need no background)."""
        self.encoder_train_mean_ = self.encoder.transform(frame).mean(axis=0)
        return self

    @property
    def origins(self) -> list[str]:
        return self.encoder.origins_
