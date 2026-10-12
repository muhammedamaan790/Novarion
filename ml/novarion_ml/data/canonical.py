"""Registry-driven canonicalization of one case's inputs + the canonical input hash (plan §5.3, §11, §11A).

This is the single authority for `input_sha256` (backend only). The canonical value produced here is the value the
model receives, the value stored in the scenario's `input_snapshot`, and the value that is hashed.

Canonical value per feature kind (identical to `load.canonicalize` for training rows):
  continuous → number rounded to `canonical_precision` (round-half-even on the decimal representation); int if
               precision is 0; -0 → 0
  binary     → int 0/1
  ordinal / nominal → category token (str, NFC-normalized, trimmed, exact match against registry categories)
  explicit unknown  → the reserved token "__UNKNOWN__" (only where `allow_unknown`)
Computed features (`input_mode: computed`, D-002) are always derived here, never taken from the client.
Constant features (`input_mode: constant`, D-007) are always filled with their registry `constant_value`.

Only registry rules live here. Checks that need a fitted ReferenceContext (training-observed range, atypical
profile, exact training-row match) are added by the inference service.
"""

from __future__ import annotations

import hashlib
import math
import unicodedata
from dataclasses import dataclass, field
from decimal import ROUND_HALF_EVEN, Decimal, InvalidOperation
from typing import Any

import rfc8785

from .registry import Feature, Registry, default_registry

BLOCK, WARN, INFO = "BLOCK", "WARN", "INFO"


@dataclass(frozen=True)
class Issue:
    code: str
    severity: str
    feature_id: str | None
    message: str
    details: dict[str, Any] = field(default_factory=dict)


@dataclass
class CanonicalResult:
    canonical: dict[str, Any] | None  # None when any BLOCK issue exists
    issues: list[Issue]
    input_sha256: str | None
    computed: dict[str, Any]

    @property
    def ready(self) -> bool:
        return not any(i.severity == BLOCK for i in self.issues)


def normalize_text(value: str) -> str:
    return unicodedata.normalize("NFC", value).strip()


def round_canonical(value: float, precision: int) -> int | float:
    quantum = Decimal(1).scaleb(-precision)
    rounded = Decimal(repr(float(value))).quantize(quantum, rounding=ROUND_HALF_EVEN)
    if precision == 0:
        out: int | float = int(rounded)
    else:
        out = float(rounded)
    return 0 if out == 0 else out  # normalizes -0 / -0.0


def entered_features(registry: Registry) -> list[Feature]:
    return [f for f in registry.features if f.input_mode == "entered"]


def computed_features(registry: Registry) -> list[Feature]:
    return [f for f in registry.features if f.input_mode == "computed"]


def constant_features(registry: Registry) -> list[Feature]:
    return [f for f in registry.features if f.input_mode == "constant"]


def _canonical_entered(feature: Feature, raw: Any, unknown: str) -> tuple[Any, Issue | None]:
    fid = feature.id
    if raw is None or (isinstance(raw, str) and normalize_text(raw) == ""):
        return None, Issue("missing_required", BLOCK, fid, "A value or an explicit UNKNOWN is required.")
    if isinstance(raw, str) and normalize_text(raw) == unknown:
        if not feature.allow_unknown:
            return None, Issue("unknown_not_allowed", BLOCK, fid, "This field must have a measured value.")
        return unknown, Issue(
            "unknown_input", WARN, fid, "Marked UNKNOWN: will be imputed (not measured) and forces LOW model confidence."
        )
    if feature.kind == "continuous":
        if isinstance(raw, bool) or not isinstance(raw, int | float):
            return None, Issue("invalid_type", BLOCK, fid, "A number is required.", {"kind": "continuous"})
        if isinstance(raw, float) and not math.isfinite(raw):
            return None, Issue("invalid_type", BLOCK, fid, "Non-finite numbers are not allowed.")
        lo, hi = feature.hard_valid_range or (-math.inf, math.inf)
        # Reject clearly impossible magnitudes BEFORE float conversion/Decimal quantization.
        # The one-unit margin preserves the existing rounding semantics at the range boundary.
        if raw < lo - 1 or raw > hi + 1:
            return None, Issue(
                "out_of_hard_range", BLOCK, fid, f"Outside the valid range [{lo}, {hi}] {feature.canonical_unit}.",
                {"value": raw, "range": [lo, hi], "unit": feature.canonical_unit},
            )
        value = round_canonical(raw, feature.canonical_precision or 0)
        if not lo <= value <= hi:
            return None, Issue(
                "out_of_hard_range", BLOCK, fid, f"Outside the valid range [{lo}, {hi}] {feature.canonical_unit}.",
                {"value": value, "range": [lo, hi], "unit": feature.canonical_unit},
            )
        return value, None
    if feature.kind == "binary":
        if isinstance(raw, bool) or not isinstance(raw, int) or raw not in (0, 1):
            return None, Issue("invalid_type", BLOCK, fid, "Binary fields take 0 or 1.", {"kind": "binary"})
        return int(raw), None
    # ordinal / nominal
    if not isinstance(raw, str):
        return None, Issue("invalid_type", BLOCK, fid, "A category token is required.", {"categories": list(feature.categories)})
    token = normalize_text(raw)
    if token not in feature.categories:
        return None, Issue(
            "unseen_category", BLOCK, fid, "Unknown category for this field.",
            {"value": token, "categories": list(feature.categories)},
        )
    return token, None


def _compute(canonical: dict[str, Any], unknown: str, registry: Registry) -> dict[str, Any]:
    """Computed features (D-002): bmi = weight / (height/100)^2; obesity = bmi > 25."""
    by_id = registry.by_id()
    weight, height = canonical.get("weight"), canonical.get("height")
    if weight is None or height is None:
        return {}
    if unknown in (weight, height):
        bmi: Any = unknown
    else:
        bmi = round_canonical(weight / (height / 100) ** 2, by_id["bmi"].canonical_precision or 0)
    obesity: Any = unknown if bmi == unknown else int(bmi > 25)
    return {"bmi": bmi, "obesity": obesity}


def canonicalize_case(
    inputs: dict[str, Any],
    unit_status: dict[str, str] | None = None,
    registry: Registry | None = None,
) -> CanonicalResult:
    """Validate + canonicalize one case. Unknown feature ids must already be rejected by the API schema."""
    registry = registry or default_registry()
    unknown = registry.unknown_token
    by_id = registry.by_id()
    unit_status = unit_status or {}
    issues: list[Issue] = []
    canonical: dict[str, Any] = {}

    for feature in entered_features(registry):
        value, issue = _canonical_entered(feature, inputs.get(feature.id), unknown)
        if issue:
            issues.append(issue)
        if value is not None:
            canonical[feature.id] = value
        status = unit_status.get(feature.id, "explicit")
        if feature.kind == "continuous" and status == "canonical_assumed" and value not in (None, unknown):
            if feature.unit_unambiguous:
                issues.append(Issue(
                    "canonical_assumed_unit", WARN, feature.id,
                    f"No unit supplied; assumed {feature.canonical_unit}. Confirm before continuing.",
                    {"unit": feature.canonical_unit},
                ))
            else:
                issues.append(Issue(
                    "unit_unknown", BLOCK, feature.id,
                    f"This value could be in more than one unit. Provide it in {feature.canonical_unit}.",
                    {"unit": feature.canonical_unit},
                ))

    for feature in constant_features(registry):
        supplied = inputs.get(feature.id)
        if supplied is not None and (isinstance(supplied, bool) or supplied != feature.constant_value):
            issues.append(Issue(
                "constant_feature_ignored", WARN, feature.id,
                "This field never varied in the training data, so the model cannot use it; the supplied value is ignored.",
                {"supplied": supplied, "used": feature.constant_value},
            ))
        canonical[feature.id] = feature.constant_value

    lymph, neut = canonical.get("lymphocytes_pct"), canonical.get("neutrophils_pct")
    if isinstance(lymph, int | float) and isinstance(neut, int | float) and lymph + neut > 100:
        issues.append(Issue(
            "cross_field_violation", BLOCK, None, "Lymphocytes % + neutrophils % cannot exceed 100.",
            {"rule": "lymph_plus_neut", "features": ["lymphocytes_pct", "neutrophils_pct"]},
        ))

    computed = _compute(canonical, unknown, registry)
    for fid, value in computed.items():
        supplied = inputs.get(fid)
        if supplied is not None and value != unknown:
            try:
                mismatch = (
                    isinstance(supplied, bool) or not isinstance(supplied, int | float)
                    or round_canonical(supplied, by_id[fid].canonical_precision or 0) != value
                )
            except (OverflowError, InvalidOperation, ValueError):
                mismatch = True  # computed values remain server-authoritative, even for unusable supplied numbers
            if mismatch:
                issues.append(Issue(
                    "computed_value_mismatch", WARN, fid, "Supplied value differs from the computed value; computed value used.",
                    {"supplied": supplied, "computed": value},
                ))
        canonical[fid] = value

    if any(i.severity == BLOCK for i in issues):
        return CanonicalResult(None, issues, None, computed)
    ordered = {f.id: canonical[f.id] for f in registry.features}
    return CanonicalResult(ordered, issues, input_sha256(ordered), computed)


def input_sha256(canonical: dict[str, Any]) -> str:
    """SHA-256 of the RFC 8785 (JCS) canonical JSON of the canonical feature vector."""
    return hashlib.sha256(rfc8785.dumps(canonical)).hexdigest()


def training_row_hashes(frame) -> dict[int, str]:
    """input_sha256 of every canonical training row (exact-match warning; same canonicalization as new inputs)."""
    out = {}
    for record_id, row in frame.iterrows():
        values = {}
        for fid, v in row.items():
            if isinstance(v, float) and v.is_integer():
                v = int(v)
            elif hasattr(v, "item"):
                v = v.item()
            values[fid] = 0 if v == 0 and not isinstance(v, str) else v
        out[int(record_id)] = input_sha256(values)
    return out


def training_data_sha256(frame, targets: dict) -> str:
    """Canonical training matrix hash (plan §11): canonical features + labels, rows sorted by dataset_record_id,
    one JCS line per row, joined by '\n' → SHA-256. Distinguishes matrices built from the same source file."""
    lines = []
    for record_id in sorted(int(i) for i in frame.index):
        features = {}
        for fid, v in frame.loc[record_id].items():
            v = v.item() if hasattr(v, "item") else v
            if isinstance(v, float) and v.is_integer():
                v = int(v)
            features[fid] = v
        labels = {t: int(series.loc[record_id]) for t, series in sorted(targets.items())}
        lines.append(rfc8785.dumps({"dataset_record_id": record_id, "features": features, "labels": labels}))
    return hashlib.sha256(b"\n".join(lines)).hexdigest()
