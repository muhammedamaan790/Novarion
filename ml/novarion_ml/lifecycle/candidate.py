"""`make candidate` — build a challenger from verified outcomes and gate it against production (plan §12B pipeline).

Order of operations (each step asserts what it may see):
  1. eligibility comes ONLY from the verification manifest (hash-checked against the lifecycle log); every eligible
     record must match its package row (input_sha256 + label_hash); dataset-library cases never appear;
  2. eligible records ordered by eligibility_sequence; the FORWARD HOLDOUT = the smallest highest-sequence suffix that
     meets every target's min_positive / min_negative (else INSUFFICIENT_EVIDENCE: keep collecting);
  3. the holdout is removed BEFORE any challenger-side step (selection, Platt, thresholds, references);
  4. challenger = the final-model procedure on 303 + remaining eligible cases → config FROZEN;
  5. champion (production final models) and challenger scored ONCE on the holdout → paired gate.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import joblib
import numpy as np
import pandas as pd

from ..calibrate.platt import Platt, sigmoid
from ..data.canonical import training_data_sha256, training_row_hashes
from ..train.config import TrainConfig, derive_seed
from .gate import gate_status, gate_target
from .log import LifecycleLog, now, sha256_jcs
from .package import PackageRecord
from .procedure import frozen_config, procedure
from .verify import eligible, manifest_hash_ok

TARGETS = ("cad", "lad", "lcx", "rca")
NEW_ROW_OFFSET = 100_000  # learning rows get record ids 100000 + eligibility_sequence (never collide with 0..302)


class CandidateError(RuntimeError):
    pass


@dataclass
class LearningRow:
    record_id: int
    learning_record_id: str
    eligibility_sequence: int
    input_sha256: str
    inputs: dict[str, Any]
    labels: dict[str, int]


def eligible_rows(records: dict[str, PackageRecord], manifest: dict[str, Any], log: LifecycleLog
                  ) -> tuple[list[LearningRow], list[str]]:
    if not manifest_hash_ok(manifest):
        raise CandidateError("verification manifest fails its hash check")
    if not log.has_hash("verify_outcomes", "verification_manifest_sha256", manifest["verification_manifest_sha256"]):
        raise CandidateError("verification manifest is not recorded in the lifecycle log (run make verify-outcomes)")
    rows, notes = [], []
    for lrid, entry in sorted(manifest["verification_manifest"]["records"].items()):
        if not eligible(entry):
            continue
        record = records.get(lrid)
        outcome = record.outcomes.get(entry["outcome_id"]) if record else None
        if outcome is None:
            notes.append(f"{lrid}: verified in the manifest but absent from this package; skipped")
            continue
        if outcome.input_sha256 != entry["input_sha256"] or outcome.label_hash != entry["label_hash"] or outcome.problems:
            notes.append(f"{lrid}: package row does not match its verified manifest entry; skipped")
            continue
        rows.append(LearningRow(NEW_ROW_OFFSET + entry["eligibility_sequence"], lrid, entry["eligibility_sequence"],
                                outcome.input_sha256, outcome.inputs, outcome.labels))
    rows.sort(key=lambda r: r.eligibility_sequence)
    return rows, notes


def forward_holdout_size(rows: list[LearningRow], gate: dict[str, Any]) -> int | None:
    """Smallest highest-sequence suffix meeting every target's minimums (None = not attainable yet)."""
    for k in range(1, len(rows) + 1):
        tail = rows[-k:]
        if all(sum(r.labels[t] for r in tail) >= gate["min_positive"][t]
               and sum(1 - r.labels[t] for r in tail) >= gate["min_negative"][t] for t in TARGETS):
            return k
    return None


def frame_of(rows: list[LearningRow], columns: list[str], like: pd.DataFrame) -> tuple[pd.DataFrame, dict]:
    frame = pd.DataFrame([{c: r.inputs[c] for c in columns} for r in rows], index=[r.record_id for r in rows],
                         columns=columns)
    frame = frame.astype(like.dtypes.to_dict()) if len(rows) else like.iloc[0:0]
    labels = {t: pd.Series({r.record_id: r.labels[t] for r in rows}, dtype=int) for t in TARGETS}
    return frame, labels


def champion_scores(bundle_dir: Path, frame: pd.DataFrame) -> dict[str, tuple[np.ndarray, np.ndarray]]:
    out = {}
    for t in TARGETS:
        d = bundle_dir / "targets" / t / "final"
        model = joblib.load(d / "model.joblib")
        c = json.loads((d / "calibrator.json").read_text(encoding="utf-8"))
        logit = Platt(c["a"], c["b"]).logit(model.margin(frame))
        out[t] = (sigmoid(logit), logit)
    return out


def build_candidate(*, records: dict[str, PackageRecord], manifest: dict[str, Any], log: LifecycleLog,
                    X: pd.DataFrame, Y: dict[str, pd.Series], train: TrainConfig, gate: dict[str, Any],
                    champion_version: str, champion_dir: Path, version: str, out_dir: Path,
                    feature_schema_sha256: str, preprocessing_version: str, tests_pass: bool = True) -> dict[str, Any]:
    rows, notes = eligible_rows(records, manifest, log)
    # The champion is bound by version AND artifact digest: promotion refuses a gate run against another champion (R06).
    champion_sha = json.loads((champion_dir / "manifest.json").read_text(encoding="utf-8"))["artifact_manifest_sha256"]
    report: dict[str, Any] = {"version": version, "champion_version": champion_version,
                              "champion_artifact_manifest_sha256": champion_sha, "created_at": now(),
                              "eligible_cases": len(rows), "notes": notes,
                              "verification_manifest_sha256": manifest["verification_manifest_sha256"],
                              "grid": {"configs": len(train.configs),
                                       "families": sorted({c.family for c in train.configs})},
                              "promotion_gate": gate, "evidence_label": "pre-promotion validation evidence"}
    size = forward_holdout_size(rows, gate) if len(rows) >= gate["min_new_cases"] else None
    if size is None:
        why = (f"{len(rows)} eligible new cases; at least {gate['min_new_cases']} are needed before a candidate is built"
               if len(rows) < gate["min_new_cases"] else
               "no forward holdout meets every target's minimum positives/negatives yet")
        targets = {t: {"evaluable": False, "auc_champion": None, "auc_challenger": None, "delta_auc_ci95": None,
                       "brier_champion": None, "brier_challenger": None, "delta_brier_ci95": None,
                       "cal_slope_ci95": None, "rules": {}, "note": why} for t in TARGETS}
        return _finish(report | {"gate_status": "INSUFFICIENT_EVIDENCE", "reason": why, "targets": targets}, out_dir)

    holdout, remaining = rows[-size:], rows[:-size]
    columns = list(X.columns)
    h_frame, h_labels = frame_of(holdout, columns, X)
    n_frame, n_labels = frame_of(remaining, columns, X)
    train_frame = pd.concat([X, n_frame]) if len(remaining) else X
    train_y = {t: pd.concat([Y[t], n_labels[t]]) if len(remaining) else Y[t] for t in TARGETS}
    holdout_hashes = {r.input_sha256 for r in holdout}
    train_hashes = set(training_row_hashes(train_frame).values())
    assert not set(h_frame.index) & set(train_frame.index), "forward holdout ids in the challenger training set"
    assert not holdout_hashes & {r.input_sha256 for r in remaining}, "forward holdout inputs in the training set"
    holdout_manifest = {"records": [{"learning_record_id": r.learning_record_id, "input_sha256": r.input_sha256,
                                     "eligibility_sequence": r.eligibility_sequence} for r in holdout]}
    holdout_manifest["forward_holdout_manifest_sha256"] = sha256_jcs(holdout_manifest["records"])

    challengers, frozen, results = {}, {}, {}
    champion = champion_scores(champion_dir, h_frame)
    for t in TARGETS:  # challenger side: sees train_frame only; the holdout is scored once, after freezing
        challengers[t] = procedure(t, train_frame, train_y[t], train)
        frozen[t] = frozen_config(challengers[t]["config"], feature_schema_sha256, preprocessing_version)
    for t in TARGETS:
        logit = challengers[t]["platt"].logit(challengers[t]["model"].margin(h_frame))
        results[t] = gate_target(t, h_labels[t].loc[h_frame.index].to_numpy(), champion[t][0], sigmoid(logit), logit,
                                 gate, derive_seed(gate["bootstrap"]["seed"], version, t))
    status = gate_status(results, tests_pass)
    out_dir.mkdir(parents=True, exist_ok=True)
    for t in TARGETS:
        d = out_dir / "targets" / t
        d.mkdir(parents=True, exist_ok=True)
        joblib.dump(challengers[t]["model"], d / "model.joblib")
        (d / "calibrator.json").write_text(json.dumps(challengers[t]["platt"].to_json()), encoding="utf-8")
        (d / "thresholds.json").write_text(json.dumps(challengers[t]["thresholds"].to_json()), encoding="utf-8")
        (d / "frozen_config.json").write_text(json.dumps(frozen[t], indent=1), encoding="utf-8")
    (out_dir / "forward_holdout_manifest.json").write_text(json.dumps(holdout_manifest, indent=1), encoding="utf-8")
    # The rows the promotion refit needs (local artifact; never published): remaining + holdout learning rows
    learning_rows = [r.__dict__ for r in rows]
    (out_dir / "learning_rows.json").write_text(json.dumps(learning_rows, indent=1), encoding="utf-8")
    report |= {"gate_status": status, "tests_pass": tests_pass, "targets": results, "frozen_configs": frozen,
               # Exactly the rows this gate approved: promotion refuses any edit, addition or removal (audit R05).
               "learning_rows_sha256": sha256_jcs(learning_rows), "learning_rows_count": len(learning_rows),
               "forward_holdout_size": size, "challenger_training_cases": len(train_frame),
               "challenger_training_data_sha256": training_data_sha256(train_frame, train_y),
               "challenger_training_row_hashes_sha256": hashlib.sha256(
                   "\n".join(sorted(train_hashes)).encode()).hexdigest(),
               "forward_holdout_manifest_sha256": holdout_manifest["forward_holdout_manifest_sha256"]}
    return _finish(report, out_dir)


def _finish(report: dict[str, Any], out_dir: Path) -> dict[str, Any]:
    doc = {"report": report, "gate_report_sha256": sha256_jcs(report)}
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "gate_report.json").write_text(json.dumps(doc, indent=1), encoding="utf-8")
    return doc
