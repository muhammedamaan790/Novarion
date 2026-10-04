"""Canonical data loading (plan §5): verified source → canonical feature frame + target vectors.

The canonical value of every feature is computed once here and is what the model receives, what is stored,
and what is hashed (plan §11, "one canonical value everywhere").
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pandas as pd

from .registry import ROOT, Feature, Registry, default_registry, load_targets

SOURCE_XLSX = ROOT / "data" / "raw" / "z_alizadeh_sani_extension.xlsx"
PIN_FILE = ROOT / "config" / "data_source.json"
DATA_SHEET = "Sheet 1 - Table 1"


class LeakageError(RuntimeError):
    """Raised when a label (or a feature derived from one) would enter the model input matrix."""


class SourceIntegrityError(RuntimeError):
    """Raised when the source file does not match its pinned checksum."""


def patient_id(dataset_record_id: int) -> str:
    """Public patient id for a dataset row (D-005): 0-based row index → 1-based, zero-padded "ZAS-0001"."""
    return f"ZAS-{int(dataset_record_id) + 1:04d}"


def dataset_record_id(patient: str) -> int:
    """Inverse of `patient_id`."""
    if not (len(patient) == 8 and patient.startswith("ZAS-") and patient[4:].isdigit()):
        raise ValueError(f"not a dataset patient id: {patient!r}")
    return int(patient[4:]) - 1


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_source(path: Path = SOURCE_XLSX) -> pd.DataFrame:
    """Read the raw source sheet after verifying the pinned SHA-256."""
    pin = json.loads(PIN_FILE.read_text(encoding="utf-8"))
    actual = _sha256(path)
    if actual != pin["source_data_sha256"]:
        raise SourceIntegrityError(f"source sha256 {actual} != pinned {pin['source_data_sha256']}")
    return pd.read_excel(path, sheet_name=DATA_SHEET)


def _canonical_column(feature: Feature, series: pd.Series) -> pd.Series:
    if feature.kind == "continuous":
        values = series.astype(float)
        return values.round(feature.canonical_precision or 0)
    tokens = feature.source_tokens
    mapped = series.map(lambda v: tokens.get(v, tokens.get(str(v), None)))
    if mapped.isna().any():
        unseen = sorted({str(v) for v, m in zip(series, mapped, strict=True) if m is None})
        raise ValueError(f"feature {feature.id}: unseen source token(s) {unseen}")
    if feature.kind == "binary":
        return mapped.astype(int)
    # ordinal + nominal: canonical category tokens (identical to the API / stored / hashed value);
    # ordinal-index and one-hot encoding happen inside the fold pipeline (registry category order).
    return mapped.astype(str)


def canonicalize(source: pd.DataFrame, registry: Registry | None = None) -> pd.DataFrame:
    """Map source columns to canonical feature ids, encodings and precision. Labels are not included."""
    registry = registry or default_registry()
    out = {}
    for feature in registry.features:
        if feature.source_column not in source.columns:
            raise KeyError(f"source column {feature.source_column!r} for feature {feature.id} missing")
        out[feature.id] = _canonical_column(feature, source[feature.source_column])
    frame = pd.DataFrame(out, index=source.index)
    frame.index.name = "dataset_record_id"
    return frame


def build_targets(source: pd.DataFrame) -> dict[str, pd.Series]:
    """Binary 0/1 target vectors per registry target id (cad, lad, lcx, rca)."""
    spec = load_targets()
    targets = {}
    for target in spec["targets"]:
        column = source[target["source_column"]]
        allowed = {target["positive_token"], target["negative_token"]}
        if not set(column.unique()) <= allowed:
            raise ValueError(f"target {target['id']}: unexpected tokens {set(column.unique()) - allowed}")
        targets[target["id"]] = (column == target["positive_token"]).astype(int).rename(target["id"])
    return targets


def assert_no_leakage(columns: list[str], registry: Registry | None = None) -> None:
    """P0: no label column, and no feature whose lineage touches a label, may be a model input."""
    registry = registry or default_registry()
    deny = registry.leakage_denylist
    source_names = {f.id: f.source_column for f in registry.features}
    for col in columns:
        names = {col, source_names.get(col, col)}
        lineage = registry.lineage(col)
        lineage |= {source_names.get(x, x) for x in lineage}
        hit = (names | lineage) & deny
        if hit:
            raise LeakageError(f"feature {col!r} is or derives from denylisted label(s) {sorted(hit)}")


def build_X(source: pd.DataFrame, registry: Registry | None = None) -> pd.DataFrame:
    """Model input matrix: canonical features only, leakage-checked. No UNKNOWN tokens may exist in training data."""
    registry = registry or default_registry()
    frame = canonicalize(source, registry)
    assert_no_leakage(list(frame.columns), registry)
    if (frame.astype(str) == registry.unknown_token).any().any():
        raise ValueError("training data must never contain the UNKNOWN token")
    if frame.isna().any().any():
        raise ValueError("training data must not contain missing values")
    return frame


def observed_decimals(series: pd.Series) -> int:
    """Max number of decimals present in a numeric source column (for precision checks)."""
    def decimals(v: float) -> int:
        text = repr(float(v))
        return 0 if "." not in text else len(text.split(".")[1].rstrip("0"))
    return int(series.dropna().map(decimals).max()) if len(series) else 0


__all__ = [
    "LeakageError",
    "SourceIntegrityError",
    "assert_no_leakage",
    "build_X",
    "build_targets",
    "canonicalize",
    "dataset_record_id",
    "load_source",
    "observed_decimals",
    "patient_id",
]
