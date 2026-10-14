"""Audit N05: published evidence carries the identity of the computation that produced it, verified, never stamped."""

import sys

from novarion_ml.data.registry import ROOT

sys.path.insert(0, str(ROOT / "scripts"))
from publish_evidence import TRAINING_RUN, binding_problem

RUN = {"split_manifest_sha256": "s" * 64, "training_data_sha256": "d" * 64, "train_config_sha256": "c" * 64}
PROD = {"model_version": "1.0.2", "artifact_manifest_sha256": "a" * 64, "training_run": dict(RUN)}


def tiers(version="1.0.2", digest="a" * 64):
    return {"source_identity": {"kind": "bundle", "model_version": version, "artifact_manifest_sha256": digest}}


def clinical(**changes):
    return {"source_identity": {"kind": "training_run", **RUN, **changes}}


def test_matching_evidence_is_published():
    assert binding_problem(PROD, tiers(), "results/displayed_tiers.json") is None
    assert binding_problem(PROD, clinical(), "results/clinical_evaluation.json") is None


def test_unversioned_evidence_is_refused_not_stamped():
    """The audit's harness: old unversioned clinical data offered to a new production v9.9.9 used to be stamped."""
    new_prod = {"model_version": "9.9.9", "artifact_manifest_sha256": "f" * 64, "training_run": dict(RUN)}
    assert "no source identity" in binding_problem(new_prod, {"subgroups": {}}, "results/clinical_evaluation.json")
    assert "no source identity" in binding_problem(PROD, {"model_version": "1.0.2"}, "results/displayed_tiers.json")


def test_same_version_other_artifact_or_other_training_run_is_refused():
    assert "not the production bundle" in binding_problem(PROD, tiers(digest="b" * 64), "tiers")  # same version!
    assert "not the production bundle" in binding_problem(PROD, tiers(version="1.0.1"), "tiers")
    for key in TRAINING_RUN:
        assert key in binding_problem(PROD, clinical(**{key: "x" * 64}), "clinical")
    no_run = {**PROD, "training_run": {k: None for k in TRAINING_RUN}}
    assert "another training run" in binding_problem(no_run, clinical(), "clinical")  # an unidentified bundle
