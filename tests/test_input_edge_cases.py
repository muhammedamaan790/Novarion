"""Small malformed requests must be rejected predictably, never become server errors."""

import json

import pytest
from app.errors import ApiError
from app.main import create_app
from app.settings import Settings
from app.strict_json import parse_strict_json
from fastapi.testclient import TestClient

from novarion_ml.data.canonical import canonicalize_case
from novarion_ml.data.registry import ROOT


@pytest.fixture
def sample():
    return json.loads((ROOT / "contracts" / "sample_patient.json").read_text())


@pytest.mark.parametrize("token", ["1e30", "1e308", "1" + "0" * 400])
@pytest.mark.parametrize("endpoint", ["validate", "predict"])
def test_finite_extreme_values_are_quality_blocked(sample, token, endpoint):
    sample["inputs"]["age"] = "REPLACE_NUMBER"
    raw = json.dumps(sample).replace('"REPLACE_NUMBER"', token)
    with TestClient(create_app(Settings(mock=True)), raise_server_exceptions=False) as client:
        response = client.post(f"/api/v1/{endpoint}", content=raw, headers={"Content-Type": "application/json"})
    if endpoint == "validate":
        assert response.status_code == 200, response.text
        assert response.json()["ready"] is False
    else:
        assert response.status_code == 422, response.text
        assert response.json()["error_code"] == "QUALITY_GATE_BLOCKED"


@pytest.mark.parametrize("raw", ["[" * 1200 + "0" + "]" * 1200, "{\"age\":" + "1" * 5000 + "}",
                                 '{"age":1e309}'])
def test_parser_extremes_use_validation_envelope(raw):
    with pytest.raises(ApiError):
        parse_strict_json(raw.encode())
    with TestClient(create_app(Settings(mock=True)), raise_server_exceptions=False) as client:
        response = client.post("/api/v1/predict", content=raw, headers={"Content-Type": "application/json"})
    assert response.status_code == 422, response.text
    assert response.json()["error_code"] == "VALIDATION_FAILED"


@pytest.mark.parametrize("value", [1e30, 1e308, 10**400])
def test_extreme_supplied_computed_value_does_not_crash(sample, value):
    result = canonicalize_case({**sample["inputs"], "bmi": value})
    assert result.ready
    assert "computed_value_mismatch" in {issue.code for issue in result.issues}
