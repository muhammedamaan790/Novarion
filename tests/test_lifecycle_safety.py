"""Audit R05/R06/R07: promotion is bound to the exact gated rows and champion; lifecycle state and log stay consistent.

No dataset needed: promotion is stopped before refit (refit_frozen is replaced by a tripwire), and rollback uses a
stub integrity check.
"""

import json

import pandas as pd
import pytest

from novarion_ml.lifecycle import promote as P
from novarion_ml.lifecycle.log import LifecycleLog, LogIntegrityError, sha256_jcs

ROWS = [{"record_id": 1000, "learning_record_id": "r1", "eligibility_sequence": 1, "input_sha256": "c" * 64,
         "inputs": {"age": 60}, "labels": {"cad": 1, "lad": 1, "lcx": 0, "rca": 0}}]
X = pd.DataFrame({"age": [50]}, index=[0])
Y = {t: pd.Series([1], index=[0]) for t in ("cad", "lad", "lcx", "rca")}


def write(path, doc):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc), encoding="utf-8")


@pytest.fixture
def world(tmp_path, monkeypatch):
    root = tmp_path
    registry_file = root / "registry" / "models.json"
    report = {"gate_status": "PASS", "champion_version": "1.0.0", "champion_artifact_manifest_sha256": "a" * 64,
              "learning_rows_sha256": sha256_jcs(ROWS), "learning_rows_count": len(ROWS),
              "frozen_configs": {t: {"config_id": f"cfg-{t}"} for t in ("cad", "lad", "lcx", "rca")}}
    gate_sha = sha256_jcs(report)
    write(root / "candidates" / "1.1.0" / "gate_report.json", {"report": report, "gate_report_sha256": gate_sha})
    write(root / "candidates" / "1.1.0" / "learning_rows.json", ROWS)
    write(registry_file, {"production_version": "1.0.0", "models": [
        {"version": "0.9.0", "status": "retired", "path": "bundles/v0.9.0", "artifact_manifest_sha256": "9" * 64},
        {"version": "1.0.0", "status": "production", "path": "bundles/v1.0.0", "artifact_manifest_sha256": "a" * 64},
        {"version": "1.1.0", "status": "candidate", "path": "candidates/1.1.0", "gate_report_sha256": gate_sha,
         "artifact_manifest_sha256": gate_sha}]})
    log = LifecycleLog(root / "registry" / "lifecycle_log.jsonl")
    log.append("candidate", "steward", {"candidate": "1.1.0", "gate_report_sha256": gate_sha})

    def tripwire(*_, **__):
        raise AssertionError("refit reached: the check must come first")

    monkeypatch.setattr(P, "refit_frozen", tripwire)
    return root, registry_file, log


def promote(root, registry_file, log, actor="approver"):
    return P.promote(root=root, registry_file=registry_file, log=log, version="1.1.0", actor=actor,
                     X=X, Y=Y, train=None, registry=None, verify=None)


def rollback(root, registry_file, log, actor="approver"):
    return P.rollback(root=root, registry_file=registry_file, log=log, version="0.9.0", actor=actor,
                      verify=lambda path: ({}, "9" * 64, {}))


@pytest.mark.parametrize("edit", [
    lambda rows: rows[0]["inputs"].update(age=61),        # a feature value
    lambda rows: rows[0]["labels"].update(cad=0),         # a label
    lambda rows: rows[0].update(learning_record_id="r9"),  # row identity
    lambda rows: rows.append(dict(rows[0])),              # row count
])
def test_promotion_refuses_rows_edited_after_the_gate_before_refit(world, edit):
    root, registry_file, log = world
    rows = json.loads(json.dumps(ROWS))
    edit(rows)
    write(root / "candidates" / "1.1.0" / "learning_rows.json", rows)
    with pytest.raises(P.PromotionError, match="changed after the gate"):
        promote(root, registry_file, log)
    assert P.read_registry(registry_file)["production_version"] == "1.0.0"


def test_unchanged_rows_pass_the_binding_and_reach_refit(world):
    root, registry_file, log = world
    with pytest.raises(AssertionError, match="refit reached"):
        promote(root, registry_file, log)


def test_promotion_refuses_a_gate_against_an_older_champion(world):
    root, registry_file, log = world
    reg = P.read_registry(registry_file)
    reg["models"].append({"version": "2.0.0", "status": "retired", "path": "bundles/v2.0.0",
                          "artifact_manifest_sha256": "b" * 64})
    P.write_registry(registry_file, P._set_production(reg, "2.0.0"))  # production moved on after the gate
    with pytest.raises(P.PromotionError, match="compared against champion 1.0.0, but production is now 2.0.0"):
        promote(root, registry_file, log)


def test_a_second_lifecycle_operation_cannot_run_at_the_same_time(world):
    root, registry_file, log = world
    (registry_file.parent / ".lifecycle.lock").write_text("123")
    with pytest.raises(P.PromotionError, match="another lifecycle operation is running"):
        rollback(root, registry_file, log)
    assert P.read_registry(registry_file)["production_version"] == "1.0.0"


def test_a_broken_log_or_missing_actor_changes_nothing(world):
    root, registry_file, log = world
    with pytest.raises(ValueError, match="needs an actor"):
        rollback(root, registry_file, log, actor=" ")
    assert P.read_registry(registry_file)["production_version"] == "1.0.0"
    lines = log.path.read_text(encoding="utf-8").splitlines()
    log.path.write_text(lines[0].replace("steward", "mallory") + "\n", encoding="utf-8")  # tampered
    with pytest.raises(LogIntegrityError):
        rollback(root, registry_file, log)
    assert P.read_registry(registry_file)["production_version"] == "1.0.0"


def test_rollback_records_intent_then_completion(world):
    root, registry_file, log = world
    rollback(root, registry_file, log)
    events = [(e["event"], e["details"].get("operation")) for e in log.verify()]
    assert events[-2:] == [("intent", "rollback"), ("rollback", None)]
    assert P.read_registry(registry_file)["production_version"] == "0.9.0"


def test_a_failed_registry_write_leaves_the_old_state_and_an_abort(world, monkeypatch):
    root, registry_file, log = world

    def broken_write(*_):
        raise OSError("disk full")

    monkeypatch.setattr(P, "write_registry", broken_write)
    with pytest.raises(OSError):
        rollback(root, registry_file, log)
    assert P.read_registry(registry_file)["production_version"] == "1.0.0"
    assert [e["event"] for e in log.verify()][-2:] == ["intent", "aborted"]


def test_a_lost_completion_entry_is_reported_and_recovered_by_the_next_command(world, monkeypatch):
    root, registry_file, log = world
    real_append = LifecycleLog.append

    def fail_on_completion(self, event, actor, details):
        if event == "rollback":
            raise OSError("log volume full")
        return real_append(self, event, actor, details)

    monkeypatch.setattr(LifecycleLog, "append", fail_on_completion)
    with pytest.raises(P.LifecycleIncomplete, match="registry now reflects the rollback"):
        rollback(root, registry_file, log)
    assert P.read_registry(registry_file)["production_version"] == "0.9.0"  # the actual state is reported
    monkeypatch.setattr(LifecycleLog, "append", real_append)
    assert P.reconcile(log, registry_file, "next-operator") == "rollback recorded as completed (recovered)"
    last = log.verify()[-1]
    assert last["event"] == "rollback" and last["details"]["recovered"] is True


def test_an_interruption_before_the_registry_write_is_recorded_as_aborted(world):
    _, registry_file, log = world
    log.append("intent", "approver", {"operation": "rollback", "production": "0.9.0", "previous_production": "1.0.0",
                                      "completion": {"restored": "0.9.0"}})  # the process died right after this
    assert P.reconcile(log, registry_file, "next-operator") == "rollback recorded as aborted (recovered)"
    assert P.read_registry(registry_file)["production_version"] == "1.0.0"
