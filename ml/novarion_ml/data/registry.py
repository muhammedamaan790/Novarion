"""Feature and target registries (single sources of truth, plan §10 / §11A)."""

from __future__ import annotations

from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[3]
CONFIG_DIR = ROOT / "config"

VALID_KINDS = {"binary", "ordinal", "nominal", "continuous"}
VALID_INPUT_MODES = {"entered", "computed", "constant"}
_ACRONYMS = {"bmi", "lvh", "ldl", "hdl", "bun", "esr", "wbc", "st", "rwma", "tg", "nlr", "fbs", "cr"}


def auto_display(feature_id: str) -> str:
    """Readable default label from a snake_case id (registry `display` overrides it)."""
    words = []
    for i, word in enumerate(feature_id.split("_")):
        if word in _ACRONYMS or len(word) == 1:
            words.append(word.upper())
        elif word == "pct":
            words.append("%")
        else:
            words.append(word.capitalize() if i == 0 else word)
    return " ".join(words)


@dataclass(frozen=True)
class Feature:
    id: str
    source_column: str
    group: str
    kind: str
    required_for_prediction: bool
    allow_unknown: bool
    editable: bool
    immutable_in_whatif: bool
    input_mode: str
    log1p: bool
    in_reduced_feature_set: bool
    source_tokens: dict[Any, Any] = field(default_factory=dict)
    categories: tuple[str, ...] = ()
    canonical_unit: str | None = None
    unit_unambiguous: bool | None = None
    canonical_precision: int | None = None
    display_precision: int | None = None
    hard_valid_range: tuple[float, float] | None = None
    derived_from: tuple[str, ...] = ()
    aliases: tuple[str, ...] = ()
    display: str = ""
    constant_value: Any = None


@dataclass(frozen=True)
class Registry:
    schema_version: str
    unknown_token: str
    leakage_denylist: frozenset[str]
    features: tuple[Feature, ...]
    engineered: tuple[dict[str, Any], ...]

    def by_id(self) -> dict[str, Feature]:
        return {f.id: f for f in self.features}

    def lineage(self, feature_id: str) -> set[str]:
        """All upstream ids/columns a feature (or engineered feature) is derived from, recursively."""
        nodes: dict[str, tuple[str, ...]] = {f.id: f.derived_from for f in self.features}
        for eng in self.engineered:
            nodes[eng["id"]] = tuple(eng.get("derived_from", ()))
        seen: set[str] = set()
        stack = list(nodes.get(feature_id, ()))
        while stack:
            node = stack.pop()
            if node in seen:
                continue
            seen.add(node)
            stack.extend(nodes.get(node, ()))
        return seen


def _build_feature(raw: dict[str, Any], defaults: dict[str, Any]) -> Feature:
    merged = {**defaults, **raw}
    kind = merged["kind"]
    if kind not in VALID_KINDS:
        raise ValueError(f"feature {merged['id']}: invalid kind {kind!r}")
    if merged["input_mode"] not in VALID_INPUT_MODES:
        raise ValueError(f"feature {merged['id']}: invalid input_mode {merged['input_mode']!r}")
    if (merged["input_mode"] == "constant") != ("constant_value" in merged):
        raise ValueError(f"feature {merged['id']}: constant_value is required exactly for input_mode 'constant'")
    rng = merged.get("hard_valid_range")
    return Feature(
        id=merged["id"],
        source_column=merged["source_column"],
        group=merged["group"],
        kind=kind,
        required_for_prediction=bool(merged["required_for_prediction"]),
        allow_unknown=bool(merged["allow_unknown"]),
        editable=bool(merged["editable"]),
        immutable_in_whatif=bool(merged["immutable_in_whatif"]),
        input_mode=merged["input_mode"],
        log1p=bool(merged["log1p"]),
        in_reduced_feature_set=bool(merged["in_reduced_feature_set"]),
        source_tokens=dict(merged.get("source_tokens") or {}),
        categories=tuple(str(c) for c in merged.get("categories") or ()),
        canonical_unit=merged.get("canonical_unit"),
        unit_unambiguous=merged.get("unit_unambiguous"),
        canonical_precision=merged.get("canonical_precision"),
        display_precision=merged.get("display_precision"),
        hard_valid_range=tuple(rng) if rng else None,
        derived_from=tuple(merged.get("derived_from") or ()),
        aliases=tuple(merged.get("aliases") or ()),
        display=merged.get("display") or auto_display(merged["id"]),
        constant_value=merged.get("constant_value"),
    )


def load_registry(path: Path | None = None) -> Registry:
    data = yaml.safe_load((path or CONFIG_DIR / "feature_registry.yaml").read_text(encoding="utf-8"))
    defaults = data.get("defaults", {})
    features = tuple(_build_feature(raw, defaults) for raw in data["features"])
    ids = [f.id for f in features]
    if len(ids) != len(set(ids)):
        raise ValueError("duplicate feature ids in registry")
    return Registry(
        schema_version=data["schema_version"],
        unknown_token=data["unknown_token"],
        leakage_denylist=frozenset(data["leakage_denylist"]),
        features=features,
        engineered=tuple(data.get("engineered_features", ())),
    )


@lru_cache(maxsize=1)
def default_registry() -> Registry:
    return load_registry()


def load_targets(path: Path | None = None) -> dict[str, Any]:
    return yaml.safe_load((path or CONFIG_DIR / "targets.yaml").read_text(encoding="utf-8"))
