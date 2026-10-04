"""Outer/inner stratified splits + the CV feasibility gate + split_manifest (plan §6.1).

No exact duplicate feature rows exist (data/schema_report.json), so splits are ungrouped; the manifest records that.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass

import numpy as np
import rfc8785
from sklearn.model_selection import StratifiedKFold

from .config import TrainConfig, derive_seed


class FeasibilityError(RuntimeError):
    """A fold would contain fewer than the pre-registered minimum of either class: training stops (never re-k)."""


@dataclass(frozen=True)
class Fold:
    target: str
    repeat: int
    fold: int
    train_ids: np.ndarray
    test_ids: np.ndarray


def check_feasible(y: np.ndarray, folds: list[tuple[np.ndarray, np.ndarray]], minimum: int, where: str) -> None:
    for i, (_, test) in enumerate(folds):
        pos = int(y[test].sum())
        neg = len(test) - pos
        if pos < minimum or neg < minimum:
            raise FeasibilityError(f"{where} fold {i}: {pos} positives / {neg} negatives (< {minimum})")


def stratified(y: np.ndarray, k: int, seed: int) -> list[tuple[np.ndarray, np.ndarray]]:
    return list(StratifiedKFold(n_splits=k, shuffle=True, random_state=seed).split(np.zeros(len(y)), y))


def outer_folds(target: str, ids: np.ndarray, y: np.ndarray, train: TrainConfig) -> list[Fold]:
    minimum = train.raw["feasibility"]["min_per_class_per_fold"]
    k = train.outer_k
    if y.sum() < 5 * k or (len(y) - y.sum()) < 5 * k:
        raise FeasibilityError(f"{target}: n_pos/n_neg below 5·outer_k")
    folds = []
    for repeat in range(train.repeats):
        splits = stratified(y, k, derive_seed(train.seeds["SPLIT_SEED"], target, "outer", repeat))
        check_feasible(y, splits, minimum, f"{target} r{repeat} outer")
        for f, (tr, te) in enumerate(splits):
            folds.append(Fold(target, repeat, f, ids[tr], ids[te]))
    return folds


def inner_splits(target: str, y_train: np.ndarray, train: TrainConfig, *scope: object) -> list[tuple[np.ndarray, np.ndarray]]:
    splits = stratified(y_train, train.inner_k, derive_seed(train.seeds["SPLIT_SEED"], target, "inner", *scope))
    check_feasible(y_train, splits, train.raw["feasibility"]["min_per_class_per_fold"], f"{target} inner {scope}")
    return splits


def split_manifest(folds_by_target: dict[str, list[Fold]], train: TrainConfig) -> dict:
    """Immutable record of every outer split; the hash is a sibling of the hashed object (non-circular)."""
    body = {
        "train_config_sha256": train.sha256,
        "grouping": "none (no exact duplicate feature rows in the source; data/schema_report.json)",
        "outer": {"k": train.outer_k, "repeats": train.repeats}, "inner": {"k": train.inner_k},
        "evaluation_repeat_id": train.evaluation_repeat,
        "targets": {
            target: [
                {"repeat": f.repeat, "fold": f.fold, "train_ids": [int(i) for i in f.train_ids],
                 "test_ids": [int(i) for i in f.test_ids],
                 "inner_seed": derive_seed(train.seeds["SPLIT_SEED"], target, "inner", f.repeat, f.fold)}
                for f in folds
            ]
            for target, folds in folds_by_target.items()
        },
    }
    return {"manifest": body, "split_manifest_sha256": hashlib.sha256(rfc8785.dumps(body)).hexdigest()}
