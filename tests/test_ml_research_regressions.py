"""Scientific audit regressions: confidence availability, identifiable calibration and evidence provenance."""

import importlib.util
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pandas as pd
import pytest
from app.schemas import TargetPrediction

from novarion_ml.calibrate.platt import calibration_slope_intercept, fit_platt
from novarion_ml.inference.engine import Engine
from novarion_ml.thresholds.layers import Qualification, Thresholds

ROOT = Path(__file__).resolve().parents[1]


def _script(name):
    spec = importlib.util.spec_from_file_location(f"research_{name}", ROOT / "scripts" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize("positive", [True, False])
def test_unmeasured_confidence_region_keeps_probability_and_valid_contract(positive):
    q = Qualification("ppv" if positive else "npv", .9, .91, 50, .96)
    thresholds = Thresholds(.5, None if positive else .2, .8 if positive else None,
                            None if positive else q, q if positive else None)
    art = SimpleNamespace(target="lad", label="LAD", anatomy_key="vessel_lad", thresholds=thresholds,
                          evaluation={"n_high_positive": 0, "ppv": None, "n_high_negative": 0, "npv": None})
    logit = 2.9444389791664403 * (1 if positive else -1)
    result = Engine({}, "final_model")._prediction(
        art, logit, {"unknown_inputs": [], "atypical_profile": {"flag": False}})
    validated = TargetPrediction(**result)
    assert validated.probability == pytest.approx(.95 if positive else .05)
    assert validated.model_confidence == "low"
    assert validated.model_confidence_reasons == ["no_validation_evidence"]
    assert validated.confidence_qualification is None and validated.evaluation_context is None


@pytest.mark.parametrize("z,y", [
    ([-2, -1, 1, 2], [0, 0, 1, 1]),       # complete separation
    ([-2, 0, 0, 2], [0, 0, 1, 1]),        # quasi-complete separation
    ([-2, -1, 1, 2], [1, 1, 0, 0]),       # reversed separation
    ([0, 0, 0, 0], [0, 0, 1, 1]),         # unidentified slope
])
def test_unidentifiable_calibration_does_not_report_a_finite_slope(z, y):
    z, y = np.array(z, dtype=float), np.array(y)
    assert not fit_platt(z, y).valid
    slope, intercept = calibration_slope_intercept(z, y)
    assert slope is None
    assert intercept is not None  # calibration-in-the-large is separately identifiable


def test_optimizer_failure_is_not_a_valid_deployable_calibrator(monkeypatch):
    monkeypatch.setattr("novarion_ml.calibrate.platt.minimize",
                        lambda *args, **kwargs: SimpleNamespace(success=False, x=np.array([1., 0.])))
    assert not fit_platt(np.array([-2., -1., 1., 2.]), np.array([0, 1, 0, 1])).valid


@pytest.mark.parametrize("field,value", [("cache_key", "old"), ("test_ids", [3, 2]),
                                        ("y_test", [1, 0]), ("target", "rca")])
def test_evaluation_rejects_stale_or_mismatched_fold_records(field, value):
    train = _script("train")
    fold = SimpleNamespace(repeat=0, fold=0, train_ids=np.array([0, 1]), test_ids=np.array([2, 3]))
    labels = pd.Series([0, 1, 0, 1])
    record = {"target": "lad", "repeat": 0, "fold": 0, "cache_key": "current", "train_ids": [0, 1],
              "test_ids": [2, 3], "y_test": [0, 1],
              "test": {name: [0, 1] for name in ("prob", "margin", "cal_logit", "pred", "region")}}
    train.validate_fold_record(record, fold, "lad", "current", labels)
    record[field] = value
    with pytest.raises(ValueError, match="mismatch"):
        train.validate_fold_record(record, fold, "lad", "current", labels)


def test_fold_evidence_uses_only_its_own_training_side_crossfitted_scores():
    build = _script("build_bundle")
    labels = pd.Series([0, 1, 0, 1])
    record = {"train_ids": [2, 0], "test_ids": [1, 3], "training_oof_prob": [.7, .1]}
    ledger = build.fold_training_ledger(record, labels)
    np.testing.assert_array_equal(ledger.probs, [.7, .1])
    np.testing.assert_array_equal(ledger.labels, [0, 0])
    with pytest.raises(ValueError, match="Legacy"):
        build.fold_training_ledger({"train_ids": [2, 0]}, labels)


@pytest.mark.parametrize("values", [[float("nan"), .1], [1.1, .1], [.1]])
def test_invalid_training_side_ledger_is_rejected(values):
    build = _script("build_bundle")
    with pytest.raises(ValueError):
        build.fold_training_ledger({"train_ids": [0, 1], "training_oof_prob": values}, pd.Series([0, 1]))


def test_bundle_replacement_rejects_source_or_external_directory():
    build = _script("build_bundle")
    assert build.validated_output_dir(ROOT / "artifacts" / "models" / "v0.1.0") == (
        ROOT / "artifacts" / "models" / "v0.1.0").resolve()
    for target in (ROOT, ROOT / "ml", ROOT / "artifacts" / "models", ROOT.parent / "external-bundle"):
        with pytest.raises(ValueError, match="Bundle output"):
            build.validated_output_dir(target)
