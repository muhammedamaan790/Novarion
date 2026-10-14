"""Audit R15: stability intervals are accepted only for exactly the fits the bundle is built from."""

import sys

from novarion_ml.data.registry import ROOT

sys.path.insert(0, str(ROOT / "scripts"))
from build_bundle import stability_problem

FOLDS = {"cad": [{"selected": "lr[C=1]"}, {"selected": "ebm"}]}


def doc(key="k1", configs=("lr[C=1]", "ebm")):
    return {"cache_key": key, "folds": [{"target": "cad", "fold": i + 1, "config_id": c} for i, c in enumerate(configs)]}


def test_matching_intervals_are_accepted():
    assert stability_problem(doc(), "k1", FOLDS) is None


def test_intervals_for_other_fits_or_configurations_are_refused():
    assert "other fits" in stability_problem(doc(key="k0"), "k1", FOLDS)
    assert "not that fold's selected configuration" in stability_problem(doc(configs=("lr[C=1]", "xgb")), "k1", FOLDS)
    assert "other fits" in stability_problem({"folds": []}, "k1", FOLDS)  # a pre-R15 file without a key


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
