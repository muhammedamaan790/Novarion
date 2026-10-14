"""Integrity checks exercise lightweight manifests even when trained weights are unavailable."""

import copy
import hashlib
import json

import pytest
import rfc8785
from app import bundle_service as service

from novarion_ml.data.registry import ROOT


def write(path, document):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(document), encoding="utf-8")


def digest(data):
    return hashlib.sha256(data).hexdigest()


@pytest.fixture
def bundle(tmp_path, monkeypatch):
    config = tmp_path / "config"
    config.mkdir()
    manifest = {"model_version": "0.1.0", "files": {}}
    for name, key in [("anatomy_map.json", "anatomy_map_sha256"),
                      ("feature_registry.yaml", "feature_schema_sha256"), ("targets.yaml", "target_schema_sha256")]:
        content = b"test: original\n"
        (config / name).write_bytes(content)
        manifest[key] = digest(content)
    monkeypatch.setattr(service, "CONFIG_DIR", config)
    directory = tmp_path / "bundle"
    claimed = digest(rfc8785.dumps(manifest))
    write(directory / "manifest.json", {"manifest": manifest, "artifact_manifest_sha256": claimed})
    index = {"artifact_manifest_sha256": claimed, "files": {}}
    write(directory / "demo_bundle" / "index.json", {"index": index,
          "demo_bundle_sha256": digest(rfc8785.dumps(index))})
    return directory, config, claimed


@pytest.mark.parametrize("name", ["feature_registry.yaml", "targets.yaml", "anatomy_map.json"])
def test_changed_serving_configuration_fails_closed(bundle, name):
    directory, config, _ = bundle
    (config / name).write_bytes(b"test: changed\n")
    with pytest.raises(service.IntegrityError, match=name):
        service.verify_bundle(directory)


def test_git_line_endings_do_not_break_compatible_bundle(bundle):
    directory, config, _ = bundle
    for path in config.iterdir():
        path.write_bytes(path.read_bytes().replace(b"\n", b"\r\n"))
    service.verify_bundle(directory)


@pytest.mark.parametrize("field,value", [("artifact_manifest_sha256", "0" * 64), ("version", "9.9.9")])
def test_registry_identity_must_match_production_bundle(bundle, tmp_path, monkeypatch, field, value):
    directory, _, claimed = bundle
    entry = {"version": "0.1.0", "path": str(directory), "artifact_manifest_sha256": claimed}
    entry[field] = value
    registry_path = tmp_path / "models.json"
    write(registry_path, {"production_version": entry["version"], "models": [entry]})
    monkeypatch.setattr(service, "REGISTRY_FILE", registry_path)
    with pytest.raises(service.IntegrityError, match="registry"):
        service.production_bundle_dir()


@pytest.mark.parametrize("safe", [True, False])
def test_legacy_evidence_is_withheld_without_changing_predictions(monkeypatch, safe):
    payload = json.loads((ROOT / "contracts" / "mock_patient.json").read_text())
    payload.pop("app_version")
    original = copy.deepcopy(payload)
    instance = service.BundleService.__new__(service.BundleService)
    instance.manifest = {"oof_ledger_method": "outer_training_inner_crossfit"} if safe else {}
    monkeypatch.setattr(instance, "_patient_file", lambda _: {"bundle": copy.deepcopy(payload)})
    result = instance.patient("ZAS-0003").model_dump(mode="json")
    assert result["targets"] == original["targets"]
    assert result["explanations"] == original["explanations"]
    if safe:
        assert result["evidence"] == original["evidence"]
    else:
        assert any(n["code"] == "legacy_oof_ledger_withheld" for n in result["quality"]["notices"])
        for evidence in result["evidence"].values():
            assert evidence["evidence_ledger"]["positive_label_rate"] is None
            assert evidence["evidence_ledger"]["n"] == 0


def test_demo_index_must_match_the_release_pin_for_its_model(bundle, tmp_path):
    """Audit R18: a rewritten index that re-declares its own hash is refused when the release pins another one."""
    directory, _, _ = bundle
    own = json.loads((directory / "demo_bundle" / "index.json").read_text(encoding="utf-8"))["demo_bundle_sha256"]
    release = tmp_path / "release_manifest.json"
    write(release, {"release_version": "9.9.9", "model_version": "0.1.0", "demo_bundle_sha256": "0" * 64})
    with pytest.raises(service.IntegrityError, match="pinned by the release manifest"):
        service.verify_bundle(directory, release)
    write(release, {"release_version": "9.9.9", "model_version": "0.1.0", "demo_bundle_sha256": own})
    service.verify_bundle(directory, release)  # the pinned index
    write(release, {"release_version": "9.9.9", "model_version": "2.0.0", "demo_bundle_sha256": "0" * 64})
    service.verify_bundle(directory, release)  # a release of another model pins nothing about this one
