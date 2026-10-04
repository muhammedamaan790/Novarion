"""Model bundle + real inference service (plan §6.11, §11 "Startup integrity", §1A Flow A/B).

Skipped until the bundle exists (scripts/train.py all && scripts/build_bundle.py).
"""

import json
import shutil
import uuid

import pytest

from novarion_ml.data.registry import ROOT

REGISTRY = ROOT / "registry" / "models.json"


def _bundle_present() -> bool:
    if not REGISTRY.exists():
        return False
    reg = json.loads(REGISTRY.read_text(encoding="utf-8"))
    entry = next((m for m in reg["models"] if m["version"] == reg["production_version"]), None)
    return bool(entry) and (ROOT / entry["path"] / "manifest.json").exists()


if not _bundle_present():  # weights are release assets, not committed (plan §15)
    pytest.skip("no model bundle built yet (scripts/train.py all && scripts/build_bundle.py)", allow_module_level=True)
pytest.importorskip("fastapi")

from app import schemas as S
from app.bundle_service import (
    BundleService,
    IntegrityError,
    production_bundle_dir,
    verify_bundle,
)
from app.main import create_app
from app.settings import Settings
from fastapi.testclient import TestClient

from novarion_ml.data.canonical import canonicalize_case
from novarion_ml.data.load import dataset_record_id

BUNDLE = production_bundle_dir()
TARGETS = ("cad", "lad", "lcx", "rca")


@pytest.fixture(scope="module")
def service():
    return BundleService(Settings())


@pytest.fixture(scope="module")
def client(service):
    return TestClient(create_app(Settings(), service=service))


@pytest.fixture(scope="module")
def patient_files():
    return {p.stem: json.loads(p.read_text(encoding="utf-8")) for p in (BUNDLE / "demo_bundle" / "patients").iterdir()}


def test_bundle_integrity_and_tamper_detection(tmp_path):
    verify_bundle(BUNDLE)
    copy = tmp_path / "bundle"
    shutil.copytree(BUNDLE, copy)
    calibrator = copy / "targets" / "lad" / "final" / "calibrator.json"
    calibrator.write_text(calibrator.read_text().replace('"a": ', '"a": 1'), encoding="utf-8")
    with pytest.raises(IntegrityError):
        verify_bundle(copy)


def test_every_patient_file_satisfies_the_contract_and_hides_ground_truth(patient_files):
    assert len(patient_files) == 303
    for pid, doc in patient_files.items():
        bundle = S.PatientBundle.model_validate({**doc["bundle"], "app_version": "0.1.0"})
        assert bundle.patient_id == pid and bundle.patient.prediction_mode == "oof"
        assert "ground_truth" not in doc["bundle"] and set(doc["ground_truth"]) == set(TARGETS)


def test_oof_probabilities_equal_the_nested_cv_outer_test_predictions(patient_files):
    split = json.loads((BUNDLE / "split_manifest.json").read_text())["manifest"]
    repeat = split["evaluation_repeat_id"]
    for t in TARGETS:
        for k in range(split["outer"]["k"]):
            rec = json.loads((ROOT / "results" / "nested" / t / f"r{repeat}f{k}.json").read_text())
            for rid, p in zip(rec["test_ids"], rec["test"]["prob"], strict=True):
                served = patient_files[f"ZAS-{rid + 1:04d}"]["bundle"]
                assert served["targets"][t]["probability"] == pytest.approx(p, rel=1e-12, abs=1e-12)
                assert served["outer_folds"][t] == k + 1


def test_an_oof_patient_never_appears_in_its_own_reference(patient_files):
    split = json.loads((BUNDLE / "split_manifest.json").read_text())["manifest"]
    repeat = split["evaluation_repeat_id"]
    for t in TARGETS:
        test_fold = {f["fold"]: set(f["test_ids"]) for f in split["targets"][t] if f["repeat"] == repeat}
        for pid, doc in patient_files.items():
            rid = dataset_record_id(pid)
            k = doc["bundle"]["outer_folds"][t] - 1
            neighbours = {dataset_record_id(n["patient_id"]) for n in doc["bundle"]["evidence"][t]["similar_patients"]["patients"]}
            assert rid in test_fold[k] and not neighbours & test_fold[k]
            assert doc["bundle"]["evidence"][t]["similar_patients"]["reference_size"] == 303 - len(test_fold[k])


def test_live_predict_reproduces_training_row_hashes_and_flags_exact_matches(client, patient_files, service):
    doc = patient_files["ZAS-0003"]["bundle"]
    entered = {f.id: doc["canonical_inputs"][f.id] for f in service.registry.features if f.input_mode == "entered"}
    body = {"request_id": str(uuid.uuid4()), "api_schema_version": "1.0.0", "input_revision": 1, "inputs": entered}
    r = client.post("/api/v1/predict", json=body)
    assert r.status_code == 200, r.text
    data = S.PredictionResponse.model_validate(r.json())
    assert data.input_sha256 == doc["input_sha256"] == canonicalize_case(entered).input_sha256
    assert data.patient.prediction_mode == "final_model" and data.quality.notices[0].code == "exact_training_match"
    assert data.model_version == service.model_version and "X-Novarion-Mock" not in r.headers


def test_live_analyze_full_explains_the_displayed_prediction(client, patient_files, service):
    doc = patient_files["ZAS-0010"]["bundle"]
    entered = {f.id: doc["canonical_inputs"][f.id] for f in service.registry.features if f.input_mode == "entered"}
    entered["ldl"] = "__UNKNOWN__"
    body = {"request_id": str(uuid.uuid4()), "api_schema_version": "1.0.0", "inputs": entered}
    data = S.AnalyzeFullResponse.model_validate(client.post("/api/v1/analyze/full", json=body).json())
    for t in TARGETS:
        assert "unknown_input" in data.targets[t].model_confidence_reasons
        ldl = next(c for c in data.explanations[t].contributions if c.feature == "ldl") if any(
            c.feature == "ldl" for c in data.explanations[t].contributions) else None
        if ldl is not None:
            assert ldl.value_status == "imputed" and ldl.imputation.fit_scope == "full_cohort"


def test_validate_warns_outside_the_training_range(client, patient_files, service):
    doc = patient_files["ZAS-0003"]["bundle"]
    entered = {f.id: doc["canonical_inputs"][f.id] for f in service.registry.features if f.input_mode == "entered"}
    entered["triglycerides"] = 4500  # inside the hard range, far outside the cohort
    body = {"request_id": str(uuid.uuid4()), "api_schema_version": "1.0.0", "input_revision": 2, "inputs": entered}
    data = client.post("/api/v1/validate", json=body).json()
    assert data["ready"] is True
    assert any(i["code"] == "outside_training_range" and i["feature_id"] == "triglycerides" for i in data["items"])


def test_dataset_endpoints_and_evaluation(client):
    assert client.get("/api/v1/health/ready").json()["ready"] is True
    listing = client.get("/api/v1/patients").json()
    assert listing["count"] == 303
    assert client.get("/api/v1/patients/ZAS-0001").status_code == 200
    truth = client.get("/api/v1/patients/ZAS-0001/ground-truth").json()
    assert set(truth["labels"]) == set(TARGETS)
    S.EvaluationResponse.model_validate(client.get("/api/v1/evaluation").json())
    assert client.get("/api/v1/global-importance/lad").json()["features"]
