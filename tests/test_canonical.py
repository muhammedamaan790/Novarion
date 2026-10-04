"""Canonical input + input_sha256 (plan §11 "Canonical hashes", "one canonical value everywhere")."""

import json

import pytest

from novarion_ml.data.canonical import canonicalize_case, round_canonical, training_row_hashes
from novarion_ml.data.load import build_X, dataset_record_id, patient_id
from novarion_ml.data.registry import ROOT

GOLDEN = json.loads((ROOT / "tests" / "golden" / "input_sha256_vectors.json").read_text(encoding="utf-8"))


def _entered(registry, row) -> dict:
    ids = [f.id for f in registry.features if f.input_mode == "entered"]
    return {fid: (row[fid].item() if hasattr(row[fid], "item") else row[fid]) for fid in ids}


def test_at_least_50_golden_vectors_reproduce_exactly():
    assert len(GOLDEN["vectors"]) >= 50
    for vector in GOLDEN["vectors"]:
        result = canonicalize_case(vector["inputs"])
        assert result.canonical == vector["canonical"], vector["name"]
        assert result.input_sha256 == vector["input_sha256"], vector["name"]


def test_train_serve_parity_on_every_dataset_row(source, registry):
    """A dataset row sent through the API canonicalizer hashes exactly like the training row (OOF provenance)."""
    X = build_X(source, registry)
    train_hashes = training_row_hashes(X)
    mismatched = []
    for record, row in X.iterrows():
        result = canonicalize_case(_entered(registry, row))
        assert result.ready, record
        if result.input_sha256 != train_hashes[record]:
            diff = {k for k in result.canonical if result.canonical[k] != row[k]}
            mismatched.append((int(record), diff))
    # D-002: row 153 has BMI = 25.0 but source Obesity = Y; the computed rule (BMI > 25) gives 0.
    assert mismatched == [(153, {"obesity"})]


@pytest.mark.parametrize(("value", "precision", "expected"), [
    (1.005, 2, 1.0), (1.015, 2, 1.02), (35.25, 1, 35.2), (35.35, 1, 35.4), (-0.0, 0, 0), (53.0, 0, 53),
])
def test_round_half_even_on_decimal_representation(value, precision, expected):
    out = round_canonical(value, precision)
    assert out == expected and type(out) is type(expected)
    assert str(out) != "-0"


def test_unknown_propagates_to_computed_features():
    vector = next(v for v in GOLDEN["vectors"] if v["name"] == "unknown_weight_makes_bmi_and_obesity_unknown")
    assert vector["canonical"]["bmi"] == "__UNKNOWN__" and vector["canonical"]["obesity"] == "__UNKNOWN__"


def test_unknown_is_blocked_where_not_allowed():
    base = GOLDEN["vectors"][0]["inputs"]
    result = canonicalize_case({**base, "age": "__UNKNOWN__"})
    assert not result.ready and result.input_sha256 is None
    assert [i.code for i in result.issues if i.severity == "BLOCK"] == ["unknown_not_allowed"]


def test_boolean_is_not_a_binary_value():
    base = GOLDEN["vectors"][0]["inputs"]
    result = canonicalize_case({**base, "diabetes": True})
    assert not result.ready


def test_patient_id_round_trip():
    assert patient_id(0) == "ZAS-0001" and patient_id(302) == "ZAS-0303"
    assert dataset_record_id("ZAS-0093") == 92
    with pytest.raises(ValueError):
        dataset_record_id("ZAS-93")


def test_constant_feature_is_auto_filled_and_never_required():
    """D-007: exertional_chest_pain never varies in training, so it is filled, not asked."""
    base = {k: v for k, v in GOLDEN["vectors"][0]["inputs"].items() if k != "exertional_chest_pain"}
    result = canonicalize_case(base)
    assert result.ready and result.canonical["exertional_chest_pain"] == 0
    assert result.input_sha256 == GOLDEN["vectors"][0]["input_sha256"]  # omitting it changes nothing


def test_supplied_constant_value_is_reported_and_ignored():
    base = GOLDEN["vectors"][0]["inputs"]
    result = canonicalize_case({**base, "exertional_chest_pain": 1})
    assert result.ready and result.canonical["exertional_chest_pain"] == 0
    assert result.input_sha256 == GOLDEN["vectors"][0]["input_sha256"]
    assert [i.code for i in result.issues] == ["constant_feature_ignored"]
