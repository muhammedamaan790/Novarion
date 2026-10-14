"""Governed learning loop (plan §12B, §11A, §15 "Learning loop (pytest)" + "Integrity & lifecycle invariants")."""

import copy
import hashlib
import json
import shutil
import sys
import uuid

import numpy as np
import pytest

from novarion_ml.data.canonical import canonicalize_case
from novarion_ml.data.load import build_targets, build_X, load_source
from novarion_ml.data.registry import ROOT, default_registry
from novarion_ml.lifecycle.candidate import CandidateError, LearningRow, eligible_rows, forward_holdout_size
from novarion_ml.lifecycle.gate import gate_status, gate_target, load_gate
from novarion_ml.lifecycle.log import LifecycleLog, LogIntegrityError
from novarion_ml.lifecycle.package import PackageError, label_definitions, load_package
from novarion_ml.lifecycle.replay import load_replay, partition
from novarion_ml.lifecycle.verify import eligible, empty_manifest, manifest_hash_ok, verify_outcomes

TARGETS = ("cad", "lad", "lcx", "rca")
REG = default_registry()
ENTERED = [f.id for f in REG.features if f.input_mode == "entered"]


@pytest.fixture(scope="module")
def data():
    source = load_source()
    return build_X(source), build_targets(source)


def _outcome(canonical_inputs, labels, **over):
    from novarion_ml.data.canonical import input_sha256

    o = {"outcome_id": str(uuid.uuid4()), "applies_to_input_sha256": input_sha256(canonical_inputs),
         "inputs": canonical_inputs, "labels": labels, "label_definition": label_definitions(),
         "source_type": "angiography_report", "source_system": "hospital_ehr", "pseudonymous_study_id": None,
         "supersedes_outcome_id": None, "correction_reason": None, "outcome_status": "pending"}
    o.update(over)
    return o


def _case_from_row(X, rid, age_shift=1):
    """A new (synthetic) case: a dataset row with age shifted, re-canonicalized (so it is NOT a training row)."""
    entered = {k: (v.item() if hasattr(v, "item") else v) for k, v in X.loc[rid][ENTERED].items()}
    entered = {k: int(v) if isinstance(v, float) and v.is_integer() else v for k, v in entered.items()}
    entered["age"] = min(110, int(entered["age"]) + age_shift)
    return canonicalize_case(entered, registry=REG).canonical


def _package(records):
    return json.dumps({"kind": "novarion_learning_package", "package_schema_version": "1.0.0", "records": records})


def _synthetic(X, Y, rids, age_shift=1):
    records, attest = [], {}
    for rid in rids:
        lrid = f"lr-{rid:04d}"
        labels = {t: int(Y[t].loc[rid]) for t in TARGETS}
        records.append({"learning_record_id": lrid, "case_source": "manual",
                        "outcomes": [_outcome(_case_from_row(X, rid, age_shift), labels)]})
        attest[lrid] = {"decision": "verify", "verification_method": "source_record_review",
                        "temporal_status": "verified", "temporal_evidence_ref": "source_record_review"}
    return records, attest


# ---------------------------------------------------------------------------------------------------- lifecycle log
def test_lifecycle_log_hash_chain_detects_edits_and_removals(tmp_path):
    log = LifecycleLog(tmp_path / "log.jsonl")
    for i in range(3):
        log.append("reject", "steward", {"candidate": f"1.{i}.0"})
    assert len(log.verify()) == 3
    lines = log.path.read_text().splitlines()
    tampered = json.loads(lines[1])
    tampered["details"]["candidate"] = "9.9.9"
    log.path.write_text("\n".join([lines[0], json.dumps(tampered), lines[2]]) + "\n")
    with pytest.raises(LogIntegrityError):
        log.verify()
    log.path.write_text("\n".join([lines[0], lines[2]]) + "\n")  # removed entry
    with pytest.raises(LogIntegrityError):
        log.verify()
    with pytest.raises(LogIntegrityError):  # a broken chain is never extended
        log.append("reject", "steward", {})


def test_lifecycle_log_requires_known_event_and_actor(tmp_path):
    log = LifecycleLog(tmp_path / "log.jsonl")
    with pytest.raises(ValueError):
        log.append("delete_everything", "x", {})
    with pytest.raises(ValueError):
        log.append("reject", " ", {})


# ---------------------------------------------------------------------------------------------------- package
def test_package_allowlist_rejects_extra_fields(data):
    X, Y = data
    records, _ = _synthetic(X, Y, [0])
    records[0]["outcomes"][0]["review_note"] = "free text must never ride along"
    with pytest.raises(PackageError, match="allowlist"):
        load_package(_package(records))
    records, _ = _synthetic(X, Y, [0])
    records[0]["reviewer"] = "Dr X"
    with pytest.raises(PackageError, match="allowlist"):
        load_package(_package(records))


def test_package_never_trusts_verified_status_and_excludes_dataset_cases(data):
    X, Y = data
    records, _ = _synthetic(X, Y, [0, 1])
    records[0]["outcomes"][0]["outcome_status"] = "verified"
    records[1]["case_source"] = "dataset"
    parsed, notes = load_package(_package(records))
    assert list(parsed) == ["lr-0000"]
    assert any("ignored" in n for n in notes) and any("dataset" in n for n in notes)
    # ...and without a steward attestation nothing becomes eligible
    manifest, report = verify_outcomes(parsed, {}, empty_manifest(), set())
    assert report["pending_no_attestation"] == ["lr-0000"] and manifest["verification_manifest"]["records"] == {}


def test_package_flags_invalid_inputs_and_definitions(data):
    X, Y = data
    records, attest = _synthetic(X, Y, [0, 1, 2])
    records[0]["outcomes"][0]["label_definition"] = {**label_definitions(), "lad": ">= 70% stenosis"}
    records[1]["outcomes"][0]["inputs"] = {**records[1]["outcomes"][0]["inputs"], "ldl": REG.unknown_token}
    records[2]["outcomes"][0]["applies_to_input_sha256"] = "0" * 64
    manifest, report = verify_outcomes(load_package(_package(records))[0], attest, empty_manifest(), set())
    recs = manifest["verification_manifest"]["records"]
    assert report["rejected"] == ["lr-0000", "lr-0001", "lr-0002"]
    assert "label definition" in recs["lr-0000"]["reasons"][0]
    assert "complete inputs" in " ".join(recs["lr-0001"]["reasons"])
    assert "does not match the inputs" in " ".join(recs["lr-0002"]["reasons"])


# ---------------------------------------------------------------------------------------------------- verification
def test_verification_trust_boundary_and_temporal_rule(data):
    X, Y = data
    records, attest = _synthetic(X, Y, [0, 1, 2])
    attest["lr-0001"] = {**attest["lr-0001"], "temporal_status": "verified", "temporal_evidence_ref": None}
    attest["lr-0002"] = {**attest["lr-0002"], "temporal_status": "insufficient_evidence"}
    manifest, _ = verify_outcomes(load_package(_package(records))[0], attest, empty_manifest(), set())
    recs = manifest["verification_manifest"]["records"]
    assert eligible(recs["lr-0000"])
    assert recs["lr-0001"]["outcome_status"] == "rejected"  # temporal "verified" without evidence
    assert recs["lr-0002"]["outcome_status"] == "verified" and not eligible(recs["lr-0002"])  # no temporal evidence
    assert manifest_hash_ok(manifest)
    manifest["verification_manifest"]["records"]["lr-0002"]["temporal_status"] = "verified"
    assert not manifest_hash_ok(manifest)


def test_verification_conflicts_corrections_and_duplicates(data):
    X, Y = data
    records, attest = _synthetic(X, Y, [0, 1, 2, 3])
    first = records[0]["outcomes"][0]
    flipped = {t: 1 - v for t, v in first["labels"].items()}
    records[0]["outcomes"].append(_outcome(first["inputs"], flipped))  # two live outcomes that disagree
    second = records[1]["outcomes"][0]
    records[1]["outcomes"].append(_outcome(second["inputs"], {t: 1 - v for t, v in second["labels"].items()},
                                           supersedes_outcome_id=second["outcome_id"],
                                           correction_reason="data_entry_error"))  # a correction
    dup_same = copy.deepcopy(records[2])
    dup_same["learning_record_id"] = "lr-9002"
    dup_same["outcomes"][0]["outcome_id"] = str(uuid.uuid4())
    dup_diff = copy.deepcopy(records[3])
    dup_diff["learning_record_id"] = "lr-9003"
    dup_diff["outcomes"][0].update(outcome_id=str(uuid.uuid4()),
                                   labels={t: 1 - v for t, v in records[3]["outcomes"][0]["labels"].items()})
    attest["lr-9002"] = attest["lr-9003"] = attest["lr-0002"]
    manifest, _ = verify_outcomes(load_package(_package([*records, dup_same, dup_diff]))[0], attest,
                                       empty_manifest(), set())
    recs = manifest["verification_manifest"]["records"]
    assert recs["lr-0000"]["outcome_status"] == "conflicted"
    assert recs["lr-0001"]["outcome_status"] == "verified"
    assert recs["lr-0001"]["outcome_id"] == records[1]["outcomes"][1]["outcome_id"]  # latest non-superseded
    assert {recs["lr-0003"]["outcome_status"], recs["lr-9003"]["outcome_status"]} == {"conflicted"}
    assert "duplicate_input_other_record" in recs["lr-9002"]["flags"] and not eligible(recs["lr-9002"])
    # same record exported twice → counted once
    again = load_package(_package([records[2], records[2]]))[0]
    assert len(again) == 1


def test_eligibility_sequence_is_append_only(data):
    X, Y = data
    records, attest = _synthetic(X, Y, [5, 3])
    m1, _ = verify_outcomes(load_package(_package(records))[0], attest, empty_manifest(), set())
    seq1 = {k: v["eligibility_sequence"] for k, v in m1["verification_manifest"]["records"].items()}
    assert seq1 == {"lr-0003": 1, "lr-0005": 2}  # learning_record_id order within a run
    more, more_attest = _synthetic(X, Y, [1, 4])
    m2, report = verify_outcomes(load_package(_package([*records, *more]))[0], {**attest, **more_attest}, m1, set())
    recs = m2["verification_manifest"]["records"]
    assert {k: recs[k]["eligibility_sequence"] for k in seq1} == seq1  # never renumbered
    assert recs["lr-0001"]["eligibility_sequence"] == 3 and recs["lr-0004"]["eligibility_sequence"] == 4
    assert sorted(report["unchanged_existing"]) == ["lr-0003", "lr-0005"]


def test_training_row_copy_is_flagged(data):
    X, Y = data
    records, attest = _synthetic(X, Y, [0], age_shift=0)  # exactly a dataset row
    from novarion_ml.data.canonical import training_row_hashes

    manifest, _ = verify_outcomes(load_package(_package(records))[0], attest, empty_manifest(),
                                  set(training_row_hashes(X).values()))
    rec = manifest["verification_manifest"]["records"]["lr-0000"]
    assert rec["flags"] == ["input_matches_training_row"] and not eligible(rec)
    attest["lr-0000"]["provenance_confirmed"] = True
    manifest, _ = verify_outcomes(load_package(_package(records))[0], attest, empty_manifest(),
                                  set(training_row_hashes(X).values()))
    assert eligible(manifest["verification_manifest"]["records"]["lr-0000"])


# ---------------------------------------------------------------------------------------------------- gate
def test_gate_rules():
    gate = load_gate()
    gate = {**gate, "bootstrap": {**gate["bootstrap"], "replicates": 300}}
    rng = np.random.default_rng(0)
    y = np.array([0] * 30 + [1] * 30)
    score = y + rng.normal(0, 0.8, 60)
    p_good = 1 / (1 + np.exp(-(score - 0.5) * 3))
    logit_good = (score - 0.5) * 3
    noise = rng.normal(0, 1, 60)
    # identical models: non-inferior but no improvement → FAIL
    same = {t: gate_target(t, y, p_good, p_good, logit_good, gate, 1) for t in TARGETS}
    assert gate_status(same) == "FAIL" and not same["cad"]["rules"]["improved"]
    # a useless challenger: ΔAUC CI lower bound far below −δ → FAIL
    bad = gate_target("cad", y, p_good, 1 / (1 + np.exp(-noise)), noise, gate, 1)
    assert not bad["rules"]["delta_auc_ci_low_above_margin"]
    # a clearly better challenger on every target → PASS (and FAIL when the test suite failed)
    p_weak = 1 / (1 + np.exp(-(0.4 * score + rng.normal(0, 1, 60) - 0.2)))
    better = {t: gate_target(t, y, p_weak, p_good, logit_good, gate, 2) for t in TARGETS}
    assert all(r["rules"]["improved"] for r in better.values())
    assert gate_status(better) == "PASS" and gate_status(better, tests_pass=False) == "FAIL"
    # too few negatives for one target → INSUFFICIENT_EVIDENCE (not FAIL)
    y_few = np.array([0] * 5 + [1] * 55)
    short = {**better, "lcx": gate_target("lcx", y_few, p_weak, p_good, logit_good, gate, 3)}
    assert not short["lcx"]["evaluable"] and gate_status(short) == "INSUFFICIENT_EVIDENCE"


def test_forward_holdout_is_smallest_suffix_meeting_minimums():
    gate = {"min_positive": dict.fromkeys(TARGETS, 2), "min_negative": dict.fromkeys(TARGETS, 2)}

    def row(seq, v):
        return LearningRow(seq, f"r{seq}", seq, str(seq), {}, dict.fromkeys(TARGETS, v))

    rows = [row(i, i % 2) for i in range(1, 11)]
    assert forward_holdout_size(rows, gate) == 4
    assert forward_holdout_size([row(i, 1) for i in range(1, 11)], gate) is None


def test_candidate_refuses_manifest_missing_from_log(data, tmp_path):
    X, Y = data
    records, attest = _synthetic(X, Y, [0])
    parsed = load_package(_package(records))[0]
    manifest, _ = verify_outcomes(parsed, attest, empty_manifest(), set())
    with pytest.raises(CandidateError, match="lifecycle log"):
        eligible_rows(parsed, manifest, LifecycleLog(tmp_path / "log.jsonl"))


# ---------------------------------------------------------------------------------------------------- replay
def test_replay_partition_is_exact_for_every_seed():
    cfg = load_replay()
    ids = list(range(303))
    seen = set()
    for s in range(cfg["seeds"]):
        initial, batches = partition(ids, s, cfg)
        assert len(initial) == 153 and [len(b) for b in batches] == [50, 50, 50]
        assert sorted(initial + [i for b in batches for i in b]) == ids
        seen.add(tuple(initial[:5]))
    assert len(seen) == cfg["seeds"]  # different arrival orders


# ---------------------------------------------------------------------------------------------------- end to end
def _production_dir():
    registry = json.loads((ROOT / "registry" / "models.json").read_text(encoding="utf-8"))
    entry = next(m for m in registry["models"] if m["version"] == registry["production_version"])
    return registry, ROOT / entry["path"]


@pytest.mark.skipif(not _production_dir()[1].exists(), reason="needs the built production bundle")
def test_cli_verify_candidate_promote_rollback_end_to_end(data, tmp_path):
    """Synthetic verified cases → candidate (strict gate) → human reject; permissive test gate → PASS → promote →
    rollback. Checks: holdout never in training, invariants, immutability, audit log, official metrics untouched."""
    sys.path.insert(0, str(ROOT / "scripts"))
    import lifecycle

    from novarion_ml.lifecycle.procedure import restrict
    from novarion_ml.train.config import default_train_config

    X, Y = data
    registry, prod_dir = _production_dir()
    root = tmp_path / "root"
    (root / "registry").mkdir(parents=True)
    rel = prod_dir.relative_to(ROOT)
    shutil.copytree(prod_dir, root / rel)
    prod_entry = next(m for m in registry["models"] if m["version"] == registry["production_version"])
    (root / "registry" / "models.json").write_text(json.dumps({"production_version": prod_entry["version"],
                                                               "models": [prod_entry]}))
    metrics_before = hashlib.sha256((ROOT / "results" / "metrics.json").read_bytes()).hexdigest()
    golden_before = hashlib.sha256((root / rel / "golden" / "golden_predictions.json").read_bytes()).hexdigest()

    train = restrict(default_train_config(), ["lr"])
    train = type(train)(train.raw, train.sha256, train.configs[:2])  # a 2-config grid keeps the test fast
    strict_gate = {**load_gate(), "bootstrap": {**load_gate()["bootstrap"], "replicates": 200}}
    paths = lifecycle.Paths(root, tests_runner=lambda: True, gate=strict_gate, train=train)
    records, attest = _synthetic(X, Y, list(range(0, 300, 2)))  # 150 synthetic new cases
    pkg, att = tmp_path / "package.json", tmp_path / "attest.json"
    pkg.write_text(_package(records))
    att.write_text(json.dumps(attest))

    assert lifecycle.main(["verify-outcomes", "--package", str(pkg), "--attest", str(att), "--steward", "S"], paths) == 0
    assert lifecycle.main(["candidate", "--package", str(pkg), "--version", "1.1.0"], paths) == 0
    cand = json.loads((root / "artifacts" / "candidates" / "v1.1.0" / "gate_report.json").read_text())
    rep = cand["report"]
    holdout = json.loads((root / "artifacts" / "candidates" / "v1.1.0" / "forward_holdout_manifest.json").read_text())
    rows = json.loads((root / "artifacts" / "candidates" / "v1.1.0" / "learning_rows.json").read_text())
    h_ids = {r["learning_record_id"] for r in holdout["records"]}
    assert rep["challenger_training_cases"] == 303 + len(rows) - len(h_ids)  # holdout never in training
    assert min(r["eligibility_sequence"] for r in holdout["records"]) > max(
        r["eligibility_sequence"] for r in rows if r["learning_record_id"] not in h_ids)  # forward by sequence
    if rep["gate_status"] != "PASS":
        assert lifecycle.main(["promote", "--version", "1.1.0", "--approver", "A"], paths) == 2  # refused
    assert lifecycle.main(["reject", "--version", "1.1.0", "--approver", "A", "--reason", "demo"], paths) == 0
    assert lifecycle.main(["promote", "--version", "1.1.0", "--approver", "A"], paths) == 2  # rejected stays rejected

    permissive = {**strict_gate, "noninferiority": {"delta_auc": 1.0, "brier_point_max": 1.0, "brier_ci_high_max": 1.0,
                                                    "cal_slope_overlap": [-1e9, 1e9], "mean_calibration_diff_max": 1.0},
                  "improvement": {"delta_auc_min": -1.0, "delta_brier_max": 1.0}}
    paths.gate = permissive
    assert lifecycle.main(["candidate", "--package", str(pkg), "--version", "1.2.0"], paths) == 0
    gated = json.loads((root / "artifacts" / "candidates" / "v1.2.0" / "gate_report.json").read_text())["report"]
    assert gated["gate_status"] == "PASS"
    assert lifecycle.main(["promote", "--version", "1.2.0", "--approver", "A"], paths) == 0
    reg = json.loads((root / "registry" / "models.json").read_text())
    assert reg["production_version"] == "1.2.0"
    new_dir = root / next(m for m in reg["models"] if m["version"] == "1.2.0")["path"]
    manifest = lifecycle._verify_bundle(new_dir)[0]
    for t in TARGETS:  # invariant: promoted config == gated config (no re-selection after the gate)
        assert manifest["selected"][t] == gated["frozen_configs"][t]["config_id"]
    assert manifest["lineage"]["gate_report_sha256"] and manifest["lineage"]["learning_rows"] == len(rows)

    assert lifecycle.main(["rollback", "--version", prod_entry["version"], "--approver", "A"], paths) == 0
    reg = json.loads((root / "registry" / "models.json").read_text())
    assert reg["production_version"] == prod_entry["version"]
    assert {m["version"]: m["status"] for m in reg["models"]} == {
        prod_entry["version"]: "production", "1.1.0": "rejected", "1.2.0": "retired"}
    # the restored bundle is byte-identical → stored v1.0 case predictions reproduce exactly
    lifecycle._verify_bundle(root / rel)
    assert hashlib.sha256((root / rel / "golden" / "golden_predictions.json").read_bytes()).hexdigest() == golden_before
    assert hashlib.sha256((ROOT / "results" / "metrics.json").read_bytes()).hexdigest() == metrics_before

    events = [e["event"] for e in paths.log.verify()]
    # every registry change is journalled: intent before it, the operation's own event after it (audit R07), now
    # including verification and candidate registration (audit N08)
    assert events == ["intent", "verify_outcomes", "intent", "candidate", "intent", "reject", "intent", "candidate",
                      "intent", "promote", "intent", "rollback"]
    lines = paths.log.path.read_text().splitlines()
    tampered = next(i for i, line in enumerate(lines) if '"demo"' in line)  # any entry: the chain must break
    lines[tampered] = lines[tampered].replace('"demo"', '"edited"')
    paths.log.path.write_text("\n".join(lines) + "\n")
    assert lifecycle.main(["verify-log"], paths) == 2
