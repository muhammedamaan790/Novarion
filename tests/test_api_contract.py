"""API contract v1 (plan §11, §11A): schemas, strict input, error envelope, fail-closed behaviour, frozen mocks."""

import copy
import json
import sys
import uuid

import pytest
from app import schemas as S
from app.main import create_app
from app.mock import MOCK_BUNDLE_SHA256, MOCK_MODEL_VERSION
from app.service import UnavailableService
from app.settings import MAX_BODY_BYTES, MAX_FEATURES_PER_REQUEST, MAX_JSON_DEPTH, MAX_STRING_CHARS, Settings
from fastapi.testclient import TestClient
from pydantic import ValidationError

from novarion_ml.data.canonical import canonicalize_case
from novarion_ml.data.registry import ROOT

sys.path.insert(0, str(ROOT / "scripts"))
import build_contracts

CONTRACTS = ROOT / "contracts"
ORIGIN = "http://localhost:5173"
MOCK_SCHEMAS = {
    "meta": S.MetaResponse, "validate": S.ValidateResponse, "validate_blocked": S.ValidateResponse,
    "predict": S.PredictionResponse, "predict_unknown_input": S.PredictionResponse,
    "analyze_full": S.AnalyzeFullResponse, "explain": S.ExplanationResponse, "evidence": S.EvidenceResponse,
    "patients": S.PatientListResponse, "patient": S.PatientBundle, "ground_truth": S.GroundTruthResponse,
    "evaluation": S.EvaluationResponse, "global_importance": S.GlobalImportanceResponse, "models": S.ModelsResponse,
    "model_report": S.ModelReportResponse, "error": S.ErrorResponse, "error_artifact_mismatch": S.ErrorResponse,
}


def load(name: str) -> dict:
    return json.loads((CONTRACTS / f"{name}.json").read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def client():
    return TestClient(create_app(Settings(mock=True, cors_origins=(ORIGIN,))))


@pytest.fixture(scope="module")
def down():
    return TestClient(create_app(Settings(), service=UnavailableService()))


@pytest.fixture
def body():
    return {**load("sample_patient"), "request_id": str(uuid.uuid4())}


def post(client, path, payload, **kw):
    return client.post(f"/api/v1{path}", json=payload, **kw)


def raw_post(client, path, text: str):
    return client.post(f"/api/v1{path}", content=text.encode(), headers={"Content-Type": "application/json"})


def assert_envelope(response, status: int, code: str) -> dict:
    assert response.status_code == status, response.text
    data = response.json()
    S.ErrorResponse.model_validate(data)
    assert data["error_code"] == code and data["api_schema_version"] == S.API_SCHEMA_VERSION
    assert "Traceback" not in response.text
    return data


# ------------------------------------------------------------------------------------------- frozen contract files
def test_openapi_is_generated_and_in_sync():
    assert build_contracts.openapi_document() == load("openapi")


@pytest.mark.parametrize("name", sorted(MOCK_SCHEMAS))
def test_every_mock_satisfies_its_schema(name):
    MOCK_SCHEMAS[name].model_validate(load(f"mock_{name}"))


def test_mocks_are_reproducible_byte_for_byte(tmp_path, source):
    build_contracts.build_all(tmp_path)
    for path in sorted(tmp_path.iterdir()):
        assert path.read_bytes() == (CONTRACTS / path.name).read_bytes(), f"{path.name} is stale: rerun build_contracts"


def test_mock_identity_is_unmistakable():
    meta = load("mock_meta")
    assert meta["model_version"] == "0.0.0" and meta["disclaimer"] == S.DISCLAIMER


# ------------------------------------------------------------------------------------------- health / fail closed
def test_health_live_and_ready(client):
    assert client.get("/api/v1/health/live").json() == {"status": "ok"}
    ready = client.get("/api/v1/health/ready")
    assert ready.status_code == 200 and ready.json()["ready"] is True


def test_without_a_bundle_everything_fails_closed(down, body):
    ready = down.get("/api/v1/health/ready")
    assert ready.status_code == 503 and ready.json()["ready"] is False and ready.json()["reason"]
    assert_envelope(post(down, "/predict", body), 503, "NOT_READY")
    assert_envelope(down.get("/api/v1/meta"), 503, "NOT_READY")
    assert down.get("/api/v1/health/live").status_code == 200


# ------------------------------------------------------------------------------------------- happy paths
def test_predict_echoes_ids_and_hash_is_server_authoritative(client, body):
    body["input_revision"] = 17
    r = post(client, "/predict", body)
    assert r.status_code == 200, r.text
    data = S.PredictionResponse.model_validate(r.json())
    assert str(data.request_id) == body["request_id"] and data.input_revision == 17
    assert data.input_sha256 == canonicalize_case(body["inputs"]).input_sha256
    assert set(data.targets) == {"cad", "lad", "lcx", "rca"} and data.commit_status == "committed"
    assert r.headers["X-Novarion-Mock"] == "1" and r.headers["X-Content-Type-Options"] == "nosniff"


def test_predict_is_input_dependent_and_unknown_forces_low(client, body):
    p1 = post(client, "/predict", body).json()
    body["inputs"] = {**body["inputs"], "ldl": "__UNKNOWN__"}
    p2 = post(client, "/predict", body).json()
    assert p1["input_sha256"] != p2["input_sha256"]
    assert all(t["model_confidence"] == "low" and "unknown_input" in t["model_confidence_reasons"]
               for t in p2["targets"].values())


def test_analyze_full_is_one_consistent_bundle(client, body):
    body.pop("input_revision")
    r = post(client, "/analyze/full", body)
    data = S.AnalyzeFullResponse.model_validate(r.json())
    for t in S.TARGET_IDS:
        assert data.explanations[t].calibrated_logit == pytest.approx(data.targets[t].calibrated_logit)


def test_explain_and_evidence_are_pinned(client, body):
    pred = post(client, "/predict", body).json()
    pinned = {**body, "analysis_id": pred["analysis_id"], "input_sha256": pred["input_sha256"], "target": "lcx",
              "model_version": MOCK_MODEL_VERSION, "artifact_manifest_sha256": MOCK_BUNDLE_SHA256}
    ok = post(client, "/explain", pinned)
    assert ok.status_code == 200 and ok.json()["target"] == "lcx"
    assert post(client, "/evidence", pinned).status_code == 200
    assert_envelope(post(client, "/explain", {**pinned, "input_sha256": "0" * 64}), 409, "INPUT_HASH_MISMATCH")
    assert_envelope(post(client, "/evidence", {**pinned, "model_version": "1.0.0"}), 409, "ARTIFACT_MISMATCH")
    assert_envelope(post(client, "/explain", {**pinned, "artifact_manifest_sha256": "a" * 64}), 409,
                    "ARTIFACT_MISMATCH")


def test_dataset_patient_endpoints(client):
    listing = client.get("/api/v1/patients").json()
    assert listing["count"] == len(listing["patients"]) == 3
    assert all("labels" not in p for p in listing["patients"])  # never in the list
    pid = listing["patients"][0]["patient_id"]
    raw = client.get(f"/api/v1/patients/{pid}").json()
    bundle = S.PatientBundle.model_validate(raw)
    assert bundle.patient.prediction_mode == "oof" and "labels" not in raw  # own ground truth only on reveal
    assert all(n.patient_id != pid for e in bundle.evidence.values() for n in e.similar_patients.patients)
    truth = client.get(f"/api/v1/patients/{pid}/ground-truth").json()
    assert set(truth["labels"]) == set(S.TARGET_IDS)
    assert_envelope(client.get("/api/v1/patients/ZAS-0300"), 404, "NOT_FOUND")
    assert_envelope(client.get("/api/v1/patients/ZAS-12"), 422, "VALIDATION_FAILED")


def test_evidence_and_model_center_endpoints(client):
    assert client.get("/api/v1/evaluation").status_code == 200
    assert client.get("/api/v1/global-importance/rca").json()["target"] == "rca"
    assert_envelope(client.get("/api/v1/global-importance/heart"), 422, "VALIDATION_FAILED")
    assert client.get("/api/v1/models").json()["production_version"] == MOCK_MODEL_VERSION
    assert client.get("/api/v1/models/0.1.0/report").json()["gate_status"] == "FAIL"
    assert_envelope(client.get("/api/v1/models/9.9.9/report"), 404, "NOT_FOUND")


# ------------------------------------------------------------------------------------------- quality gate
def test_validate_reports_instead_of_rejecting(client, body):
    body["inputs"] = {**body["inputs"], "age": None, "ldl": 9000}
    data = post(client, "/validate", body).json()
    assert data["ready"] is False and data["input_sha256"] is None
    assert {i["code"] for i in data["items"] if i["severity"] == "BLOCK"} == {"missing_required", "out_of_hard_range"}
    assert data["counts"]["missing_required"] == 1 and data["counts"]["out_of_range"] == 1


def test_validate_dataset_provenance(client, body):
    patient = load("mock_dataset_patients")["patients"][1]
    body["dataset_record_id"] = patient["dataset_record_id"]
    matched = post(client, "/validate", body).json()
    assert matched["provenance"]["prediction_mode"] == "oof" and matched["provenance"]["input_hash_match"] is True
    body["inputs"] = {**body["inputs"], "pulse_rate": body["inputs"]["pulse_rate"] + 1}
    edited = post(client, "/validate", body).json()
    assert edited["provenance"]["prediction_mode"] == "final_model"
    assert "dataset_record_mismatch" in {i["code"] for i in edited["items"]}


def test_predict_never_runs_on_blocked_inputs(client, body):
    body["inputs"] = {**body["inputs"], "ldl": 9000}
    data = assert_envelope(post(client, "/predict", body), 422, "QUALITY_GATE_BLOCKED")
    assert data["details"]["items"][0]["feature_id"] == "ldl"


# ------------------------------------------------------------------------------------------- strict input
def test_unknown_feature_ids_and_identifiers_are_rejected(client, body):
    r = post(client, "/predict", {**body, "inputs": {**body["inputs"], "patient_name": "Jane Doe"}})
    assert_envelope(r, 422, "VALIDATION_FAILED")
    assert "Jane Doe" not in r.text  # submitted values are never echoed
    assert_envelope(post(client, "/predict", {**body, "mrn": "12345"}), 422, "VALIDATION_FAILED")


def test_missing_feature_wrong_type_and_bool_are_rejected(client, body):
    inputs = dict(body["inputs"])
    inputs.pop("hdl")
    assert_envelope(post(client, "/predict", {**body, "inputs": inputs}), 422, "VALIDATION_FAILED")
    assert_envelope(post(client, "/predict", {**body, "inputs": {**body["inputs"], "diabetes": True}}), 422,
                    "VALIDATION_FAILED")  # a JSON boolean is never a binary 0/1 value
    assert_envelope(post(client, "/predict", {**body, "inputs": {**body["inputs"], "age": [53]}}), 422,
                    "VALIDATION_FAILED")


def test_incompatible_schema_version(client, body):
    data = assert_envelope(post(client, "/predict", {**body, "api_schema_version": "2.0.0"}), 422,
                           "VALIDATION_FAILED")
    assert data["details"]["reason"] == "schema_version"


@pytest.mark.parametrize(("patch", "reason"), [
    ('"age": 53, "age": 54', "duplicate_key"),
    ('"age": NaN', "non_finite"),
    ('"age": Infinity', "non_finite"),
    ('"age": -Infinity', "non_finite"),
])
def test_strict_json_parse(client, body, patch, reason):
    inputs = {k: v for k, v in body["inputs"].items() if k != "age"}
    text = json.dumps({**body, "inputs": inputs})
    text = text.replace('"inputs": {', '"inputs": {' + patch + ", ", 1)
    data = assert_envelope(raw_post(client, "/predict", text), 422, "VALIDATION_FAILED")
    assert data["details"]["reason"] == reason
    assert data["request_id"] == body["request_id"]


def test_depth_size_and_string_limits(client, body):
    deep = {**body, "unit_status": {"a": {"b": {"c": {"d": {"e": {"f": 1}}}}}}}
    assert assert_envelope(post(client, "/predict", deep), 422, "VALIDATION_FAILED")["details"]["reason"] == "depth"
    huge = {**body, "pad": "x" * (MAX_BODY_BYTES + 1)}
    assert_envelope(post(client, "/predict", huge), 413, "PAYLOAD_TOO_LARGE")
    long = {**body, "inputs": {**body["inputs"], "bundle_branch_block": "x" * (MAX_STRING_CHARS + 1)}}
    assert assert_envelope(post(client, "/predict", long), 422, "VALIDATION_FAILED")["details"]["reason"] == \
        "string_length"
    assert_envelope(raw_post(client, "/predict", "{not json"), 422, "VALIDATION_FAILED")


def test_frozen_limits():
    assert (MAX_BODY_BYTES, MAX_JSON_DEPTH, MAX_STRING_CHARS, MAX_FEATURES_PER_REQUEST) == (64 * 1024, 6, 256, 100)


# ------------------------------------------------------------------------------------------- errors / security
def test_unknown_route_uses_the_envelope(client):
    assert_envelope(client.get("/api/v1/nope"), 404, "NOT_FOUND")


def test_unhandled_errors_never_leak_a_trace(body):
    class Broken(UnavailableService):
        def predict(self, req):
            raise RuntimeError("secret internal detail")

    c = TestClient(create_app(Settings(), service=Broken()), raise_server_exceptions=False)
    r = post(c, "/predict", body)
    assert_envelope(r, 500, "INTERNAL_ERROR")
    assert "secret internal detail" not in r.text


def test_cors_is_an_exact_allowlist(client):
    ok = client.get("/api/v1/health/live", headers={"Origin": ORIGIN})
    assert ok.headers.get("access-control-allow-origin") == ORIGIN
    evil = client.get("/api/v1/health/live", headers={"Origin": "https://evil.example"})
    assert "access-control-allow-origin" not in evil.headers
    with pytest.raises(ValueError):
        import os

        os.environ["NOVARION_CORS_ORIGINS"] = "*"
        try:
            Settings.from_env()
        finally:
            del os.environ["NOVARION_CORS_ORIGINS"]


def test_docs_only_in_local_mode_and_no_promote_route():
    live = TestClient(create_app(Settings(run_mode="live", mock=True)))
    local = TestClient(create_app(Settings(run_mode="local", mock=True)))
    assert live.get("/api/v1/docs").status_code == 404 and local.get("/api/v1/docs").status_code == 200
    # the published contract is the local-mode superset; a hosted (live) app has no promote route at all
    assert any(path.endswith("/promote") for path in load("openapi")["paths"])
    assert not any("promote" in path for path in live.get("/api/v1/openapi.json").json()["paths"])


# ------------------------------------------------------------------------------------------- schema invariants
def _broken(name: str, mutate) -> None:
    data = copy.deepcopy(load(f"mock_{name}"))
    mutate(data)
    with pytest.raises(ValidationError):
        MOCK_SCHEMAS[name].model_validate(data)


def test_fail_closed_requires_all_four_targets():
    _broken("predict", lambda d: d["targets"].pop("rca"))


def test_probability_must_match_logit_and_threshold():
    _broken("predict", lambda d: d["targets"]["cad"].update(probability=0.99))
    _broken("predict", lambda d: d["targets"]["cad"].update(predicted_class="positive"))


def test_low_confidence_never_carries_ppv_npv():
    def add_ppv(d):
        low = next(t for t in d["targets"].values() if t["model_confidence"] == "low")
        low["evaluation_context"] = {"metric": "ppv", "value": 0.9, "ci": None, "n": 30}
    _broken("predict", add_ppv)


def test_explanation_must_be_additive_and_sorted():
    _broken("explain", lambda d: d["contributions"][0].update(contribution=d["contributions"][0]["contribution"] + 1))
    _broken("explain", lambda d: d["contributions"].reverse())


def test_rejected_analysis_cannot_contain_a_complete_target():
    _broken("error", lambda d: d["target_status"].update(cad="complete"))


def test_unknown_input_forces_low_in_the_schema():
    def make_high(d):
        for t in d["targets"].values():
            t["model_confidence_reasons"] = [r for r in t["model_confidence_reasons"] if r != "unknown_input"]
    _broken("predict_unknown_input", make_high)


def test_constant_feature_is_not_asked_and_case_origin_is_client_owned(client, body):
    meta = client.get("/api/v1/meta").json()
    spec = next(f for f in meta["features"] if f["id"] == "exertional_chest_pain")
    assert spec["input_mode"] == "constant" and spec["constant_value"] == 0
    assert "exertional_chest_pain" not in body["inputs"]
    pred = post(client, "/predict", body).json()
    assert pred["patient"] == {"prediction_mode": "final_model"}  # the server never guesses the case origin


def test_rate_limit_returns_the_envelope_and_spares_health_checks(body):
    c = TestClient(create_app(Settings(mock=True, rate_limit_per_minute=60, rate_limit_burst=3)))
    for _ in range(3):
        assert post(c, "/predict", body).status_code == 200
    r = post(c, "/predict", body)
    data = assert_envelope(r, 429, "RATE_LIMITED")
    assert int(r.headers["Retry-After"]) >= 1 and data["details"]["retry_after_s"] > 0
    assert c.get("/api/v1/health/ready").status_code == 200  # never throttled


def test_proxy_header_is_trusted_only_when_configured(body):
    tight = {"mock": True, "rate_limit_per_minute": 60, "rate_limit_burst": 1}
    spoofed = TestClient(create_app(Settings(**tight)))
    assert post(spoofed, "/predict", body, headers={"X-Real-IP": "1.1.1.1"}).status_code == 200
    assert post(spoofed, "/predict", body, headers={"X-Real-IP": "2.2.2.2"}).status_code == 429  # header ignored
    proxied = TestClient(create_app(Settings(**tight, trust_proxy=True)))
    assert post(proxied, "/predict", body, headers={"X-Real-IP": "1.1.1.1"}).status_code == 200
    assert post(proxied, "/predict", body, headers={"X-Real-IP": "2.2.2.2"}).status_code == 200  # separate buckets


def test_promote_route_is_local_only_token_gated_and_wraps_the_cli():
    """Plan §12B / Tier 3: the in-app Promote is a local-mode wrapper around the authoritative CLI."""
    body = {"approver": "Dr Reviewer"}
    live = TestClient(create_app(Settings(mock=True)))
    assert live.post("/api/v1/models/1.1.0/promote", json=body).status_code == 404  # hosted: no route at all

    no_token = TestClient(create_app(Settings(mock=True, run_mode="local")))
    assert no_token.post("/api/v1/models/1.1.0/promote", json=body,
                         headers={"X-Novarion-Admin-Token": "anything"}).json()["error_code"] == "FORBIDDEN"

    app = create_app(Settings(mock=True, run_mode="local", admin_token="s3cret-token"))
    calls = []
    app.state.promote_runner = lambda v, a: (calls.append((v, a)) or (2, "refused: gate status is FAIL; only PASS can be promoted"))
    client = TestClient(app)
    for headers in ({}, {"X-Novarion-Admin-Token": "wrong"}):
        r = client.post("/api/v1/models/1.1.0/promote", json=body, headers=headers)
        assert r.status_code == 403 and r.json()["error_code"] == "FORBIDDEN"
    assert calls == []  # the CLI never runs without the token
    ok_headers = {"X-Novarion-Admin-Token": "s3cret-token"}
    r = client.post("/api/v1/models/1.1.0/promote", json=body, headers=ok_headers)
    assert r.status_code == 409 and r.json()["error_code"] == "PROMOTION_REFUSED"
    assert "only PASS" in r.json()["message"] and calls == [("1.1.0", "Dr Reviewer")]
    app.state.promote_runner = lambda v, a: (0, "promoted")
    r = client.post("/api/v1/models/1.1.0/promote", json=body, headers=ok_headers)
    assert r.status_code == 200 and r.json()["restart_required"] is True
    assert client.post("/api/v1/models/1.1.0/promote", json={"approver": "x"}, headers=ok_headers).status_code == 422
