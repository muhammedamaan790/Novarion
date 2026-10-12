"""Demo patients are chosen by an outcome-blind, recomputable rule (plan §17 "Demo patients are fixed in advance")."""

import hashlib
import json

import pytest
import yaml

from novarion_ml.data.registry import ROOT

CONFIG = yaml.safe_load((ROOT / "config" / "demo_config.yaml").read_text(encoding="utf-8"))


def _index():
    reg = json.loads((ROOT / "registry" / "models.json").read_text(encoding="utf-8"))
    entry = next(m for m in reg["models"] if m["version"] == reg["production_version"])
    path = ROOT / entry["path"] / "demo_bundle" / "index.json"
    if not path.exists():
        pytest.skip("model bundle not built")
    return json.loads(path.read_text(encoding="utf-8"))["index"]["patients"]


@pytest.mark.parametrize("role", ["main_demo", "case_b"])
def test_demo_patient_is_recomputable_from_its_seed(role):
    patients = _index()
    entry = CONFIG[role]
    chosen = patients[int(hashlib.sha256(entry["seed"].encode()).hexdigest(), 16) % len(patients)]
    assert chosen["patient_id"] == entry["patient_id"]
    assert chosen["dataset_record_id"] == entry["dataset_record_id"]
    assert chosen["expected_input_sha256"] == entry["expected_input_sha256"]


def test_the_rule_consults_no_outcomes():
    assert "no predictions, labels or metrics" in CONFIG["selection_rule"]
    assert CONFIG["main_demo"]["patient_id"] != CONFIG["case_b"]["patient_id"]
