"""Promote / reject / rollback (plan §12B "Promote", "Audit log + rollback"; §11A coordination rules). CLI-only.

Promote (human approval, gate PASS only): refit the EXACT frozen configuration on 303 + all eligible learning rows
(training + forward holdout; no re-selection), Platt + thresholds from cross-fitted margins of that expanded set →
a new immutable bundle = the production bundle with its four final-model artifacts replaced → integrity check →
registry pointer (atomic) → one lifecycle-log entry.

What a promoted bundle does NOT change (documented in its manifest `lineage`):
- dataset patients keep their out-of-fold analyses from the frozen v1.0 nested-CV evaluation (the official result);
- ReferenceContexts (imputation, similar patients, cohort comparisons, ledger) stay the public 303-patient cohort, so
  learning rows are training-only and never shown to anyone as "similar patients";
- the cohort-level evaluation context stays the v1.0 nested-CV Table 2; the gate's holdout metrics are labelled
  "pre-promotion validation evidence", never the promoted model's unbiased performance.
"""

from __future__ import annotations

import contextlib
import json
import os
import shutil
import tempfile
import uuid
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import joblib
import pandas as pd
import rfc8785

from ..data.canonical import canonicalize_case, training_data_sha256
from ..data.registry import Registry
from ..inference.engine import Engine, TargetArtifact
from ..train.config import TrainConfig
from .candidate import TARGETS, LearningRow, frame_of
from .log import LifecycleLog, now, sha256_jcs
from .procedure import refit_frozen

UUID_NAMESPACE = uuid.UUID("6f1d3c1e-6c55-4c5e-9a43-6e6f76617269")


class PromotionError(RuntimeError):
    pass


class LifecycleIncomplete(PromotionError):
    """The registry changed but its completion entry could not be written; the next lifecycle command records it."""


# ------------------------------------------------------------------------------------------------ coordination (R06/R07)
@contextmanager
def lifecycle_lock(directory: Path) -> Iterator[None]:
    """One lifecycle operation at a time: a second one fails instead of racing on the registry."""
    lock = directory / ".lifecycle.lock"
    try:
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        raise PromotionError(f"another lifecycle operation is running (delete {lock} only if none is)") from None
    try:
        os.write(fd, str(os.getpid()).encode())
        os.close(fd)
        yield
    finally:
        lock.unlink(missing_ok=True)


def _state_matches(registry_file: Path, plan: dict[str, Any]) -> bool:
    """Did the planned change happen? Judged from the actual files, never from what the journal hoped."""
    op = plan["operation"]
    if op == "verify_outcomes":
        manifest = registry_file.parent / "verification_manifest.json"
        return manifest.exists() and json.loads(manifest.read_text(encoding="utf-8")).get(
            "verification_manifest_sha256") == plan["verification_manifest_sha256"]
    registry = read_registry(registry_file) if registry_file.exists() else {"production_version": None, "models": []}
    if op == "reject":
        return any(m["version"] == plan["candidate"] and m["status"] == "rejected" for m in registry["models"])
    if op == "candidate":
        return any(m["version"] == plan["candidate"] for m in registry["models"])
    return registry["production_version"] == plan["production"]  # promote, rollback, publish


def _unresolved_intents(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Intents no later entry closes (by intent_seq), wherever they are in the log: an older, uncoordinated writer may
    have appended after an interrupted operation (audit N08)."""
    closed = {e["details"].get("intent_seq") for e in entries if e["event"] != "intent"}
    return [e for e in entries if e["event"] == "intent" and e["seq"] not in closed]


def reconcile(log: LifecycleLog, registry_file: Path, actor: str) -> str | None:
    """Close every operation interrupted between its intent and its completion entry, by the ACTUAL state: completed
    if the planned change is there, aborted if it is not. Returns what was recorded, if anything."""
    recorded = []
    for intent in _unresolved_intents(log.verify()):
        plan = intent["details"]
        if _state_matches(registry_file, plan):
            log.append(plan["operation"], actor, {**plan["completion"], "intent_seq": intent["seq"], "recovered": True})
            recorded.append(f"{plan['operation']} recorded as completed (recovered)")
        else:
            log.append("aborted", actor, {"operation": plan["operation"], "intent_seq": intent["seq"],
                                          "reason": "interrupted before the change was made"})
            recorded.append(f"{plan['operation']} recorded as aborted (recovered)")
    return "; ".join(recorded) or None


def _apply(log: LifecycleLog, registry_file: Path, actor: str, plan: dict[str, Any],
           change: dict[str, Any] | Callable[[], None], completion: dict[str, Any]) -> None:
    """intent -> atomic change -> completion. `change` is the new registry, or a function making another atomic write
    (the verification manifest). The intent append validates the actor and the log chain before anything changes;
    any later interruption is resolved by reconcile() from the actual state."""
    intent = log.append("intent", actor, {**plan, "completion": completion})
    try:
        if callable(change):
            change()
        else:
            write_registry(registry_file, change)
    except Exception:
        # Best effort: if this append fails too, the next command's reconcile() records the abort instead.
        with contextlib.suppress(Exception):
            log.append("aborted", actor, {"operation": plan["operation"], "intent_seq": intent["seq"],
                                          "reason": "write failed; nothing changed"})
        raise
    try:
        log.append(plan["operation"], actor, {**completion, "intent_seq": intent["seq"]})
    except Exception as exc:
        raise LifecycleIncomplete(f"the registry now reflects the {plan['operation']}, but its completion entry could "
                                  f"not be written ({exc}); the next lifecycle command records it") from exc


# ------------------------------------------------------------------------------------------------ registry helpers
def read_registry(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_registry(path: Path, registry: dict[str, Any]) -> None:
    """Atomic: temp file in the same directory + fsync + rename."""
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".models.", suffix=".json")
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(json.dumps(registry, indent=1, ensure_ascii=False) + "\n")
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


def entry(registry: dict[str, Any], version: str) -> dict[str, Any]:
    found = [m for m in registry["models"] if m["version"] == version]
    if not found:
        raise PromotionError(f"version {version} is not in the registry")
    return found[0]


def _set_production(registry: dict[str, Any], version: str) -> dict[str, Any]:
    models = []
    for m in registry["models"]:
        if m["version"] == version:
            models.append({**m, "status": "production"})
        elif m["status"] == "production":
            models.append({**m, "status": "retired"})
        else:
            models.append(m)
    return {**registry, "production_version": version, "models": models}


def write_json_atomic(path: Path, doc: dict[str, Any]) -> None:
    """Atomic: temp file in the same directory + fsync + rename."""
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.stem}.", suffix=".json")
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(json.dumps(doc, indent=1, ensure_ascii=False) + "\n")
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


def register_candidate(*, registry_file: Path, log: LifecycleLog, actor: str, version: str, doc: dict[str, Any],
                       path: str, training_cases: int, champion: str, details: dict[str, Any]) -> None:
    """Register a gated candidate under the lifecycle lock, journaled like every other registry change (audit N08).
    The gate was computed against `champion`; if production changed meanwhile, the candidate must be rebuilt."""
    with lifecycle_lock(registry_file.parent):
        reconcile(log, registry_file, actor)
        registry = read_registry(registry_file)
        if registry["production_version"] != champion:
            raise PromotionError(f"production changed from v{champion} to v{registry['production_version']} while the "
                                 "candidate was being built; build it again against the current production")
        if any(m["version"] == version for m in registry["models"]):
            raise PromotionError(f"version {version} already exists in the registry (versions are immutable)")
        new = {**registry, "models": [*registry["models"], {
            "version": version, "status": "candidate", "created_at": doc["report"]["created_at"],
            "training_cases": training_cases, "gate_status": doc["report"]["gate_status"],
            "gate_report_sha256": doc["gate_report_sha256"], "artifact_manifest_sha256": doc["gate_report_sha256"],
            "path": path}]}
        _apply(log, registry_file, actor, {"operation": "candidate", "candidate": version}, new, details)


def record_verification(*, registry_file: Path, log: LifecycleLog, actor: str, manifest: dict[str, Any],
                        base_sha256: str | None, details: dict[str, Any]) -> None:
    """Write a new verification manifest under the lifecycle lock, journaled (audit N08). `base_sha256` is the manifest
    the verification was computed from (None: there was none); a manifest changed meanwhile is refused."""
    manifest_file = registry_file.parent / "verification_manifest.json"
    with lifecycle_lock(registry_file.parent):
        reconcile(log, registry_file, actor)
        current = (json.loads(manifest_file.read_text(encoding="utf-8")).get("verification_manifest_sha256")
                   if manifest_file.exists() else None)
        if current != base_sha256:
            raise PromotionError("the verification manifest changed while this verification ran; run it again")
        sha = manifest["verification_manifest_sha256"]
        _apply(log, registry_file, actor, {"operation": "verify_outcomes", "verification_manifest_sha256": sha},
               lambda: write_json_atomic(manifest_file, manifest), {**details, "verification_manifest_sha256": sha})


def publish_bundle(*, registry_file: Path, log: LifecycleLog, actor: str, entry_fields: dict[str, Any]) -> None:
    """Make a freshly built bundle production (scripts/build_bundle.py) under the lifecycle lock, journaled (audit N08).
    Earlier versions are kept and retired: bundles referenced by the registry are never deleted."""
    registry_file.parent.mkdir(parents=True, exist_ok=True)
    version = entry_fields["version"]
    with lifecycle_lock(registry_file.parent):
        reconcile(log, registry_file, actor)
        previous = read_registry(registry_file) if registry_file.exists() else {"production_version": None, "models": []}
        history = [{**m, "status": "retired" if m["status"] == "production" else m["status"]}
                   for m in previous["models"] if m["version"] != version]
        new = {"production_version": version, "models": [*history, entry_fields]}
        prev = previous["production_version"]
        _apply(log, registry_file, actor, {"operation": "publish", "production": version, "previous_production": prev},
               new, {"published": version, "previous_production": prev,
                     "artifact_manifest_sha256": entry_fields["artifact_manifest_sha256"]})


# ------------------------------------------------------------------------------------------------ actions
def _gate_doc(root: Path, cand: dict[str, Any], log: LifecycleLog) -> dict[str, Any]:
    doc = json.loads((root / cand["path"] / "gate_report.json").read_text(encoding="utf-8"))
    if sha256_jcs(doc["report"]) != doc["gate_report_sha256"] or doc["gate_report_sha256"] != cand["gate_report_sha256"]:
        raise PromotionError("gate report hash mismatch")
    if not log.has_hash("candidate", "gate_report_sha256", doc["gate_report_sha256"]):
        raise PromotionError("gate report is not recorded in the lifecycle log")
    return doc


def reject(*, root: Path, registry_file: Path, log: LifecycleLog, version: str, actor: str, reason: str) -> None:
    with lifecycle_lock(registry_file.parent):
        reconcile(log, registry_file, actor)
        registry = read_registry(registry_file)
        cand = entry(registry, version)
        if cand["status"] != "candidate":
            raise PromotionError(f"{version} is {cand['status']}, not a candidate")
        doc = _gate_doc(root, cand, log)
        new = {**registry, "models": [{**m, "status": "rejected"} if m["version"] == version else m
                                      for m in registry["models"]]}
        _apply(log, registry_file, actor, {"operation": "reject", "candidate": version}, new,
               {"candidate": version, "gate_status": doc["report"]["gate_status"],
                "gate_report_sha256": doc["gate_report_sha256"], "reason": reason,
                "production": registry["production_version"]})


def rollback(*, root: Path, registry_file: Path, log: LifecycleLog, version: str, actor: str,
             verify: Callable[[Path], tuple[dict, str, dict]]) -> None:
    """Restore a previous production bundle (whole and immutable: model, calibrator, thresholds, references...)."""
    with lifecycle_lock(registry_file.parent):
        reconcile(log, registry_file, actor)
        _rollback(root=root, registry_file=registry_file, log=log, version=version, actor=actor, verify=verify)


def _rollback(*, root: Path, registry_file: Path, log: LifecycleLog, version: str, actor: str,
              verify: Callable[[Path], tuple[dict, str, dict]]) -> None:
    registry = read_registry(registry_file)
    target = entry(registry, version)
    if target["status"] not in ("retired", "production"):
        raise PromotionError(f"only a previously deployed bundle can be restored ({version} is {target['status']})")
    if version == registry["production_version"]:
        raise PromotionError(f"{version} is already production")
    _, sha, _ = verify(root / target["path"])  # prepare + verify integrity BEFORE switching the pointer
    if sha != target["artifact_manifest_sha256"]:
        raise PromotionError("bundle on disk does not match its registry entry")
    previous = registry["production_version"]
    _apply(log, registry_file, actor, {"operation": "rollback", "production": version, "previous_production": previous},
           _set_production(registry, version),
           {"restored": version, "previous_production": previous, "artifact_manifest_sha256": sha})


def promote(*, root: Path, registry_file: Path, log: LifecycleLog, version: str, actor: str, X: pd.DataFrame,
            Y: dict[str, pd.Series], train: TrainConfig, registry: Registry,
            verify: Callable[[Path], tuple[dict, str, dict]]) -> Path:
    with lifecycle_lock(registry_file.parent):
        reconcile(log, registry_file, actor)
        return _promote(root=root, registry_file=registry_file, log=log, version=version, actor=actor, X=X, Y=Y,
                        train=train, registry=registry, verify=verify)


def _promote(*, root: Path, registry_file: Path, log: LifecycleLog, version: str, actor: str, X: pd.DataFrame,
             Y: dict[str, pd.Series], train: TrainConfig, registry: Registry,
             verify: Callable[[Path], tuple[dict, str, dict]]) -> Path:
    if not actor.strip():
        raise PromotionError("every lifecycle event needs an actor (steward / approver name)")
    log.verify()  # fail fast, before an expensive refit, on a broken log
    reg = read_registry(registry_file)
    cand = entry(reg, version)
    if cand["status"] == "replay" or "replay" in Path(cand["path"]).parts:
        raise PromotionError("replay models can never become production")
    if cand["status"] != "candidate":
        raise PromotionError(f"{version} is {cand['status']}, not a candidate")
    doc = _gate_doc(root, cand, log)
    report = doc["report"]
    if report["gate_status"] != "PASS":
        raise PromotionError(f"gate status is {report['gate_status']}; only PASS can be promoted")
    # R06: the gate compared this challenger with ONE champion; production must still be exactly that champion.
    production = entry(reg, reg["production_version"])
    if (report.get("champion_version") != production["version"]
            or report.get("champion_artifact_manifest_sha256") != production["artifact_manifest_sha256"]):
        raise PromotionError(f"the gate compared against champion {report.get('champion_version')}, but production is "
                             f"now {production['version']}; build and gate a new candidate against it")
    # R05: refit only on exactly the rows the gate approved (content, count and order bound into the hashed report).
    cand_dir = root / cand["path"]
    raw_rows = json.loads((cand_dir / "learning_rows.json").read_text(encoding="utf-8"))
    if "learning_rows_sha256" not in report:
        raise PromotionError("this gate report predates learning-row binding; build and gate the candidate again")
    if sha256_jcs(raw_rows) != report["learning_rows_sha256"] or len(raw_rows) != report.get("learning_rows_count"):
        raise PromotionError("learning_rows.json changed after the gate approved it; build and gate the candidate again")
    rows = [LearningRow(**r) for r in raw_rows]
    new_frame, new_y = frame_of(rows, list(X.columns), X)
    full = pd.concat([X, new_frame])
    full_y = {t: pd.concat([Y[t], new_y[t]]) for t in TARGETS}
    refits = {}
    for t in TARGETS:
        frozen = report["frozen_configs"][t]
        refits[t] = refit_frozen(t, full, full_y[t], train, frozen)
        assert refits[t]["selected"] == frozen["config_id"]  # invariant: promoted config == gated config

    parent_version = reg["production_version"]
    parent_dir = root / entry(reg, parent_version)["path"]
    parent_manifest, parent_sha, _ = verify(parent_dir)
    if parent_sha != entry(reg, parent_version)["artifact_manifest_sha256"]:
        raise PromotionError("the production bundle on disk does not match its registry entry")
    out = parent_dir.parent / f"v{version}"
    if out.exists():
        raise PromotionError(f"{out} already exists (bundles are immutable)")
    shutil.copytree(parent_dir, out)
    try:
        _write_promoted(out, version, parent_version, parent_manifest, refits, report, doc, full, full_y, registry)
        manifest, sha, _ = verify(out)
    except Exception:
        shutil.rmtree(out, ignore_errors=True)
        raise
    reg = read_registry(registry_file)
    reg["models"] = [m for m in reg["models"] if m["version"] != version] + [{
        "version": version, "status": "candidate", "created_at": manifest["created_at"], "training_cases": len(full),
        "gate_status": "PASS", "gate_report_sha256": doc["gate_report_sha256"], "artifact_manifest_sha256": sha,
        "path": str(out.relative_to(root)).replace("\\", "/"), "candidate_path": cand["path"]}]
    try:
        _apply(log, registry_file, actor, {"operation": "promote", "production": version,
                                           "previous_production": parent_version},
               _set_production(reg, version),
               {"candidate": version, "previous_production": parent_version,
                "gate_report_sha256": doc["gate_report_sha256"], "artifact_manifest_sha256": sha,
                "config_ids": {t: report["frozen_configs"][t]["config_id"] for t in TARGETS}})
    except LifecycleIncomplete:
        raise  # production switched: the new bundle is in use and must stay
    except Exception:
        if read_registry(registry_file)["production_version"] != version:
            shutil.rmtree(out, ignore_errors=True)  # nothing switched to it: no orphan bundle blocks a retry
        raise
    return out


def _write_promoted(out: Path, version: str, parent_version: str, parent_manifest: dict[str, Any],
                    refits: dict[str, Any], report: dict[str, Any], doc: dict[str, Any], full: pd.DataFrame,
                    full_y: dict[str, pd.Series], registry: Registry) -> None:
    import hashlib

    def sha(p: Path) -> str:
        return hashlib.sha256(p.read_bytes()).hexdigest()

    def dump(path: Path, obj: Any, compact: bool = False) -> None:
        path.write_text((json.dumps(obj, separators=(",", ":")) if compact else json.dumps(obj, indent=1)) + "\n",
                        encoding="utf-8")

    arts = {}
    for t in TARGETS:
        d = out / "targets" / t / "final"
        r = refits[t]
        joblib.dump(r["model"], d / "model.joblib")
        dump(d / "calibrator.json", r["platt"].to_json())
        dump(d / "thresholds.json", r["thresholds"].to_json())
        dump(d / "selection.json", {"target": t, "selected": r["selected"], "family": r["family"],
                                    "procedure": "promotion refit of the gated frozen configuration (no re-selection)",
                                    "platt": r["platt"].to_json(), "guard_log": r["guard_log"]})
        ref = joblib.load(d / "reference_context.joblib")  # unchanged public-cohort reference (see module doc)
        strength = json.loads((out / "strength_cutpoints.json").read_text(encoding="utf-8"))[t]
        evaluation = json.loads((out / "evaluation" / "metrics.json").read_text(encoding="utf-8"))
        arts[t] = TargetArtifact(t, "", "", r["model"], r["platt"], r["thresholds"], ref, strength,
                                 evaluation["targets"][t]["table2"])
    # Golden set: same fixed inputs, new final models (a MINOR version, so outputs may differ from the parent)
    golden_path = out / "golden" / "golden_predictions.json"
    golden = json.loads(golden_path.read_text(encoding="utf-8"))
    engine = Engine(arts, mode="final_model", registry=registry)
    for case in golden["cases"]:
        res = engine.analyze(canonicalize_case(case["inputs"], registry=registry).canonical)
        case["targets"] = {t: {"probability": res["targets"][t]["probability"],
                               "calibrated_logit": res["targets"][t]["calibrated_logit"],
                               "predicted_class": res["targets"][t]["predicted_class"],
                               "model_confidence_region": res["targets"][t]["model_confidence_region"],
                               "model_confidence_reasons": res["targets"][t]["model_confidence_reasons"],
                               "contributions": {c["feature"]: c["contribution"]
                                                 for c in res["explanations"][t]["contributions"]}} for t in TARGETS}
    dump(golden_path, golden)

    manifest = dict(parent_manifest)
    files = {str(p.relative_to(out)).replace("\\", "/"): sha(p) for p in sorted(out.rglob("*"))
             if p.is_file() and "demo_bundle" not in p.relative_to(out).parts and p.name != "manifest.json"}
    manifest.update({
        "model_version": version, "training_data_sha256": training_data_sha256(full, full_y),
        "selected": {t: refits[t]["selected"] for t in TARGETS}, "files": files, "created_at": now(),
        "lineage": {"parent_version": parent_version, "gate_report_sha256": doc["gate_report_sha256"],
                    "verification_manifest_sha256": report["verification_manifest_sha256"],
                    "forward_holdout_manifest_sha256": report["forward_holdout_manifest_sha256"],
                    "training_cases": len(full), "learning_rows": len(full) - 303,
                    "oof_analyses_from": "frozen v1.0 nested-CV evaluation (dataset patients, unchanged)",
                    "reference_context": "public 303-patient cohort (learning rows are training-only)",
                    "evaluation_context": "v1.0 nested-CV Table 2; gate metrics = pre-promotion validation evidence"},
    })
    artifact_sha = hashlib.sha256(rfc8785.dumps(manifest)).hexdigest()
    dump(out / "manifest.json", {"manifest": manifest, "artifact_manifest_sha256": artifact_sha})
    # Re-stamp the demo bundle so it belongs to this bundle (OOF content unchanged; provenance says where it is from)
    demo = out / "demo_bundle"
    for p in sorted((demo / "patients").iterdir()):
        d = json.loads(p.read_text(encoding="utf-8"))
        b = d["bundle"]
        source_id = f"oof:{version}:{b['patient_id']}"
        b.update(model_version=version, artifact_manifest_sha256=artifact_sha, source_oof_analysis_id=source_id,
                 analysis_id=str(uuid.uuid5(UUID_NAMESPACE, source_id)))
        dump(p, d, compact=True)
    index_doc = json.loads((demo / "index.json").read_text(encoding="utf-8"))
    index = index_doc["index"]
    index.update(model_version=version, artifact_manifest_sha256=artifact_sha,
                 files={f"patients/{p.name}": sha(p) for p in sorted((demo / "patients").iterdir())})
    dump(demo / "index.json", {"index": index, "demo_bundle_sha256": hashlib.sha256(rfc8785.dumps(index)).hexdigest()})
