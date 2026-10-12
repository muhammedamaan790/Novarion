"""Pre-registered training configuration (config/train.yaml): the 92-configuration grid + derived seeds (plan §6.1)."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from functools import lru_cache
from itertools import product
from pathlib import Path
from typing import Any

import yaml

from ..data.registry import CONFIG_DIR
from ..hashing import normalized_text_bytes

TRAIN_YAML = CONFIG_DIR / "train.yaml"


@dataclass(frozen=True)
class ModelConfig:
    config_id: str
    family: str
    params: dict[str, Any] = field(hash=False)
    feature_set: str = "full"
    class_weight: str = "none"
    complexity_rank: int = 0


@dataclass(frozen=True)
class TrainConfig:
    raw: dict[str, Any]
    sha256: str
    configs: tuple[ModelConfig, ...]

    @property
    def seeds(self) -> dict[str, int]:
        return self.raw["seeds"]

    @property
    def outer_k(self) -> int:
        return self.raw["outer"]["k"]

    @property
    def repeats(self) -> int:
        return self.raw["outer"]["repeats"]

    @property
    def inner_k(self) -> int:
        return self.raw["inner"]["k"]

    @property
    def evaluation_repeat(self) -> int:
        return self.raw["evaluation_repeat_id"]

    def by_id(self) -> dict[str, ModelConfig]:
        return {c.config_id: c for c in self.configs}


def derive_seed(*parts: object) -> int:
    """Deterministic 31-bit seed from a namespace path, e.g. derive_seed(SPLIT_SEED, "lad", repeat, fold)."""
    digest = hashlib.sha256("|".join(str(p) for p in parts).encode()).hexdigest()
    return int(digest[:8], 16) & 0x7FFFFFFF


def _within_family(family: str, spec: dict[str, Any]) -> list[dict[str, Any]]:
    grid = spec["grid"]
    if family == "lr":  # elasticnet before l2, then smaller C (stronger regularization) first
        return [{"penalty": p, "C": c} for p, c in product(grid["penalty"], sorted(grid["C"]))]
    if family == "ebm":  # fewer bins first
        return [{"max_bins": b} for b in sorted(grid["max_bins"])]
    if family == "xgboost":  # shallower depth, then fewer trees
        return [{"max_depth": d, "n_estimators": n} for d, n in product(sorted(grid["max_depth"]), sorted(grid["n_estimators"]))]
    if family == "catboost":
        return [{"depth": d, "iterations": n} for d, n in product(sorted(grid["depth"]), sorted(grid["iterations"]))]
    raise ValueError(f"unknown family {family!r}")


def expand_grid(raw: dict[str, Any]) -> tuple[ModelConfig, ...]:
    configs = []
    for family in raw["family_order"]:
        for params in _within_family(family, raw["families"][family]):
            for feature_set in raw["feature_set_order"]:
                for class_weight in raw["class_weight_order"]:
                    pid = ",".join(f"{k}={v}" for k, v in params.items())
                    configs.append(ModelConfig(
                        config_id=f"{family}[{pid}]|fs={feature_set}|cw={class_weight}",
                        family=family, params=params, feature_set=feature_set, class_weight=class_weight,
                        complexity_rank=len(configs),
                    ))
    return tuple(configs)


def load_train_config(path: Path = TRAIN_YAML) -> TrainConfig:
    text = normalized_text_bytes(path.read_bytes())  # same hash on Windows (CRLF) and Linux checkouts
    raw = yaml.safe_load(text)
    return TrainConfig(raw=raw, sha256=hashlib.sha256(text).hexdigest(), configs=expand_grid(raw))


@lru_cache(maxsize=1)
def default_train_config() -> TrainConfig:
    return load_train_config()
