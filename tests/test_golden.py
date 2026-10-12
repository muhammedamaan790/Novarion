"""Golden prediction set (plan §11 "Versioning"): the loaded production bundle must reproduce every golden case.

A future release that changes any of these beyond the stated tolerances is not a patch release.
"""

import json

import pytest

from novarion_ml.data.registry import ROOT

pytest.importorskip("fastapi")


def _bundle():
    reg = json.loads((ROOT / "registry" / "models.json").read_text(encoding="utf-8"))
    entry = next(m for m in reg["models"] if m["version"] == reg["production_version"])
    golden = ROOT / entry["path"] / "golden" / "golden_predictions.json"
    if not golden.exists():
        pytest.skip("production bundle has no golden set (built before v1.0.0)")
    return json.loads(golden.read_text(encoding="utf-8"))


def test_production_bundle_reproduces_the_golden_set():
    from app.bundle_service import BundleService
    from app.settings import Settings

    from novarion_ml.data.canonical import canonicalize_case

    golden = _bundle()
    tol = golden["tolerances"]
    engine = BundleService(Settings()).engine
    assert len(golden["cases"]) >= 20
    for case in golden["cases"]:
        result = canonicalize_case(case["inputs"])
        assert result.input_sha256 == case["input_sha256"], case["name"]
        out = engine.analyze(result.canonical)
        for t, expected in case["targets"].items():
            got = out["targets"][t]
            assert got["predicted_class"] == expected["predicted_class"], (case["name"], t)
            assert got["model_confidence_region"] == expected["model_confidence_region"], (case["name"], t)
            assert got["model_confidence_reasons"] == expected["model_confidence_reasons"], (case["name"], t)
            assert got["probability"] == pytest.approx(expected["probability"], abs=tol["probability_abs"])
            assert got["calibrated_logit"] == pytest.approx(expected["calibrated_logit"], abs=tol["calibrated_logit_abs"])
            contributions = {c["feature"]: c["contribution"] for c in out["explanations"][t]["contributions"]}
            assert contributions.keys() == expected["contributions"].keys()
            for f, v in expected["contributions"].items():
                assert contributions[f] == pytest.approx(v, rel=tol["contribution_rtol"], abs=tol["contribution_atol"])
