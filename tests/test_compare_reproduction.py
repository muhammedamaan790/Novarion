"""Audit R16: the reproduction comparison fails on every kind of discrepancy instead of skipping it."""

import math
import sys

from novarion_ml.data.registry import ROOT

sys.path.insert(0, str(ROOT / "scripts"))
from compare_reproduction import max_numeric_diff, missing_outputs, splits_identical


def test_finite_versus_non_finite_is_a_difference_in_either_order():
    for a, b in ((0.8, math.nan), (math.nan, 0.8), (0.8, math.inf), (-math.inf, 0.8)):
        _, issues = max_numeric_diff({"auc": a}, {"auc": b})
        assert issues, (a, b)
    assert max_numeric_diff({"auc": math.nan}, {"auc": math.nan}) == (0.0, [])  # undefined on both sides: same
    assert max_numeric_diff({"x": math.inf}, {"x": math.inf}) == (0.0, [])
    assert max_numeric_diff({"auc": 0.8}, {"auc": None})[1]


def test_a_numeric_split_id_difference_fails():
    a = {"split_manifest_sha256": "s", "folds": [{"test_ids": [1, 2, 3]}]}
    assert splits_identical(a, a) == (True, [])
    b = {"split_manifest_sha256": "s", "folds": [{"test_ids": [1, 2, 4]}]}
    same, issues = splits_identical(a, b)
    assert not same and "split ids differ" in issues[0]
    same, issues = splits_identical(a, {**a, "split_manifest_sha256": "t"})
    assert not same and "split_manifest_sha256 differs" in issues[0]


def test_an_output_missing_on_the_other_side_is_a_failure(tmp_path):
    here, other = tmp_path / "here", tmp_path / "other"
    for rel in ("results/stability.json", "registry/replay.json"):
        (here / rel).parent.mkdir(parents=True, exist_ok=True)
        (here / rel).write_text("{}")
    (other / "results").mkdir(parents=True)
    (other / "results" / "stability.json").write_text("{}")
    assert missing_outputs(here, other) == ["registry/replay.json"]


def _golden(p=0.8, cls="positive", name="dataset_ZAS-0001", sha="a" * 64):
    return [{"name": name, "input_sha256": sha,
             "targets": {t: {"probability": p, "predicted_class": cls} for t in ("cad", "lad", "lcx", "rca")}}]


def test_golden_predictions_are_compared_finite_aware_and_by_case_identity():
    """Audit N09: the golden loop used abs()/max(), so a NaN on one side was silently dropped."""
    from compare_reproduction import golden_diff

    assert golden_diff(_golden(), _golden()) == (0.0, [])
    assert golden_diff(_golden(), _golden(p=math.nan))[1]  # one-sided NaN is a difference
    assert golden_diff(_golden(p=math.nan), _golden(p=math.nan)) == (0.0, [])
    assert golden_diff(_golden(), _golden(cls="negative"))[1]
    assert "golden cases differ" in golden_diff(_golden(), _golden(sha="b" * 64))[1][0]  # other inputs
    assert "golden cases differ" in golden_diff(_golden(), [])[1][0]  # missing cases


def test_ledger_scores_are_compared_finite_aware_and_require_the_reference():
    from compare_reproduction import ledger_diff

    folds = {"cad:0": {"training_oof_prob": [0.1, 0.2]}}
    assert ledger_diff(folds, lambda t, k: {"training_oof_prob": [0.1, 0.2]}) == (0.0, [])
    assert ledger_diff(folds, lambda t, k: {"training_oof_prob": [0.1, math.nan]})[1]
    assert "no training_oof_prob" in ledger_diff(folds, lambda t, k: {})[1][0]
    assert ledger_diff(folds, lambda t, k: {"training_oof_prob": [0.1]})[1]  # length mismatch
