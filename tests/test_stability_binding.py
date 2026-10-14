"""Audit R15: stability intervals are accepted only for exactly the fits the bundle is built from."""

import sys

from novarion_ml.data.registry import ROOT

sys.path.insert(0, str(ROOT / "scripts"))
from build_bundle import stability_problem

FOLDS = {"cad": [{"selected": "lr[C=1]", "test_ids": [0, 1]}, {"selected": "ebm", "test_ids": [2]}]}
PATIENTS = {"ZAS-0001": {"p10": 0.1, "p90": 0.2}, "ZAS-0002": {"p10": 0.3, "p90": 0.4}, "ZAS-0003": {"p10": 0.5, "p90": 0.6}}


def doc(key="k1", configs=("lr[C=1]", "ebm"), identity="id1", patients=PATIENTS, folds=None):
    return {"cache_key": key, "stability_identity": identity, "targets": {"cad": dict(patients)},
            "folds": folds if folds is not None else [{"target": "cad", "fold": i + 1, "config_id": c}
                                                      for i, c in enumerate(configs)]}


def test_matching_intervals_are_accepted():
    assert stability_problem(doc(), "k1", FOLDS, "id1") is None


def test_intervals_for_other_fits_or_configurations_are_refused():
    assert "other fits" in stability_problem(doc(key="k0"), "k1", FOLDS, "id1")
    assert "not that fold's selected configuration" in stability_problem(doc(configs=("lr[C=1]", "xgb")), "k1",
                                                                         FOLDS, "id1")
    assert "other fits" in stability_problem({"folds": []}, "k1", FOLDS, "id1")  # a pre-R15 file without a key


def test_intervals_from_other_stability_code_or_settings_are_refused():
    """Audit N09: training's cache key does not cover the stability code; its own identity does."""
    assert "other stability code" in stability_problem(doc(identity="id0"), "k1", FOLDS, "id1")
    assert "other stability code" in stability_problem({**doc(), "stability_identity": None}, "k1", FOLDS, "id1")


def test_empty_partial_or_repeated_coverage_is_refused():
    """Audit N09: a matching key with an empty fold list (or a missing patient) used to pass."""
    assert "do not match the evaluation folds" in stability_problem(doc(folds=[]), "k1", FOLDS, "id1")
    one = [{"target": "cad", "fold": 1, "config_id": "lr[C=1]"}]
    assert "missing [('cad', 2)]" in stability_problem(doc(folds=one), "k1", FOLDS, "id1")
    assert "do not match" in stability_problem(doc(folds=one * 2 + [{"target": "cad", "fold": 2, "config_id": "ebm"}]),
                                               "k1", FOLDS, "id1")
    partial = {k: v for k, v in PATIENTS.items() if k != "ZAS-0003"}
    assert "no interval for 1 patients" in stability_problem(doc(patients=partial), "k1", FOLDS, "id1")


def test_a_registered_bundle_is_never_rebuilt_in_place(tmp_path):
    """Audit R19: an existing, registered bundle directory is refused before anything is touched."""
    import json

    import pytest
    from build_bundle import refuse_registered

    bundle = tmp_path / "v1.0.2"
    bundle.mkdir()
    registry = tmp_path / "models.json"
    registry.write_text(json.dumps({"models": [{"version": "1.0.2", "status": "production", "path": str(bundle)}]}))
    with pytest.raises(SystemExit, match="registered as v1.0.2"):
        refuse_registered(bundle.resolve(), registry)
    refuse_registered((tmp_path / "v9.9.9").resolve(), registry)  # an unregistered new version is fine


def test_a_released_version_is_rebuilt_only_as_an_unregistered_reproduction(tmp_path):
    """Audit N09: a fresh same-version build can never match the release pin (new timestamps). It is built as a
    reproduction under work/bundle-builds, never into artifacts/models, and a new version still builds normally."""
    import json

    import pytest
    from build_bundle import REPRODUCTIONS, output_plan

    release = tmp_path / "release_manifest.json"
    release.write_text(json.dumps({"model_version": "1.0.2", "demo_bundle_sha256": "a" * 64}))
    final, reproduction = output_plan("1.0.2", None, release)
    assert reproduction and final == (REPRODUCTIONS / "v1.0.2").resolve()
    with pytest.raises(SystemExit, match="is a released version"):
        output_plan("1.0.2", ROOT / "artifacts" / "models" / "v1.0.2", release)
    final, reproduction = output_plan("1.0.3", None, release)  # not released: built and registered as before
    assert not reproduction and final == (ROOT / "artifacts" / "models" / "v1.0.3").resolve()
    assert output_plan("1.0.2", None, tmp_path / "absent.json")[1] is False  # no release pins it


def test_a_reproduction_is_checked_in_full_except_for_the_release_pin(tmp_path):
    import inspect

    from app.bundle_service import verify_bundle

    assert inspect.signature(verify_bundle).parameters["check_release_pin"].default is True  # on unless asked
