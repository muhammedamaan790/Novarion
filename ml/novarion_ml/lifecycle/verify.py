"""`make verify-outcomes` — the model steward's verification step (plan §12B hard rules 1–1e, §11A).

Inputs: a learning package + the steward's attestation file. The steward attests per learning_record_id; nothing in
the package itself can make an outcome eligible. Automated checks (label definition, complete canonical input,
allowlisted enums, conflicts, duplicates) run first and override any attestation.

Attestation file (JSON): {"<learning_record_id>": {"decision": "verify" | "reject",
    "verification_method": "source_record_review" | "registry_cross_check",
    "temporal_status": "verified" | "insufficient_evidence" | "rejected",
    "temporal_evidence_ref": "source_record_review" | "attested_by_data_owner" | null,
    "provenance_confirmed": false}}   # needed only for flagged duplicate inputs

Output: the cumulative verification manifest. Existing records (and their eligibility_sequence) are never changed;
new verified records are numbered after the current maximum, in learning_record_id order.
"""

from __future__ import annotations

from typing import Any

from .log import sha256_jcs
from .package import PackageRecord, active_outcomes

VERIFICATION_METHODS = ("source_record_review", "registry_cross_check")
TEMPORAL_STATUSES = ("verified", "insufficient_evidence", "rejected")
TEMPORAL_REFS = ("source_record_review", "attested_by_data_owner")
SCHEMA_VERSION = "1.0.0"


def empty_manifest() -> dict[str, Any]:
    return {"verification_manifest": {"schema_version": SCHEMA_VERSION, "records": {}},
            "verification_manifest_sha256": sha256_jcs({})}


def manifest_hash_ok(manifest: dict[str, Any]) -> bool:
    return sha256_jcs(manifest["verification_manifest"]["records"]) == manifest["verification_manifest_sha256"]


def _attestation_problems(a: dict[str, Any]) -> list[str]:
    problems = []
    if a.get("decision") not in ("verify", "reject"):
        problems.append("attestation decision must be verify or reject")
    if a.get("verification_method") not in VERIFICATION_METHODS:
        problems.append(f"verification_method must be one of {VERIFICATION_METHODS}")
    if a.get("temporal_status") not in TEMPORAL_STATUSES:
        problems.append(f"temporal_status must be one of {TEMPORAL_STATUSES}")
    if a.get("temporal_status") == "verified" and a.get("temporal_evidence_ref") not in TEMPORAL_REFS:
        problems.append("temporal_status verified needs temporal_evidence_ref (no temporal evidence = not eligible)")
    return problems


def verify_outcomes(records: dict[str, PackageRecord], attestations: dict[str, dict[str, Any]],
                    previous: dict[str, Any], training_hashes: set[str]) -> tuple[dict[str, Any], dict[str, Any]]:
    """Returns (new cumulative manifest, run report). `training_hashes` = input_sha256 of every dataset row."""
    if not manifest_hash_ok(previous):
        raise ValueError("previous verification manifest fails its hash check")
    existing: dict[str, Any] = dict(previous["verification_manifest"]["records"])
    report: dict[str, list[str]] = {"verified": [], "rejected": [], "conflicted": [], "pending_no_attestation": [],
                                    "unchanged_existing": [], "flagged": []}
    decided: dict[str, dict[str, Any]] = {}
    for lrid in sorted(records):
        if lrid in existing:
            report["unchanged_existing"].append(lrid)
            continue
        record = records[lrid]
        active = active_outcomes(record)
        if not active:
            continue
        att = attestations.get(lrid)
        if att is None:
            report["pending_no_attestation"].append(lrid)
            continue
        outcome = active[0]
        entry: dict[str, Any] = {
            "learning_record_id": lrid, "outcome_id": outcome.outcome_id, "input_sha256": outcome.input_sha256,
            "label_hash": outcome.label_hash, "outcome_status": "verified", "temporal_status": att.get("temporal_status"),
            "temporal_evidence_ref": att.get("temporal_evidence_ref"),
            "verification_method": att.get("verification_method"), "eligibility_sequence": None, "flags": [],
            "provenance_confirmed": bool(att.get("provenance_confirmed", False)), "reasons": [],
        }
        if len({(o.input_sha256, o.label_hash) for o in active}) > 1:
            entry.update(outcome_status="conflicted", reasons=["disagreeing non-superseded outcomes in one record"])
        else:
            problems = outcome.problems + _attestation_problems(att)
            if problems:
                entry.update(outcome_status="rejected", reasons=problems)
            elif att["decision"] == "reject":
                entry.update(outcome_status="rejected", reasons=["rejected by the model steward"])
        if outcome.input_sha256 in training_hashes:
            entry["flags"].append("input_matches_training_row")
        decided[lrid] = entry
    # Cross-record checks: identical inputs across different learning records (including already-verified ones)
    by_input: dict[str, list[dict[str, Any]]] = {}
    for e in [*existing.values(), *decided.values()]:
        if e["outcome_status"] in ("verified", "conflicted"):
            by_input.setdefault(e["input_sha256"], []).append(e)
    for group in by_input.values():
        if len(group) < 2:
            continue
        new = [e for e in group if e["learning_record_id"] in decided]
        if len({e["label_hash"] for e in group}) > 1:
            for e in new:  # existing records are immutable; only the newcomers are marked
                e.update(outcome_status="conflicted", reasons=[*e["reasons"], ("same input as another record, "
                                                                "different verified labels")])
        else:
            for e in new:
                e["flags"].append("duplicate_input_other_record")
    # Number the newly verified records after the current maximum (never renumber existing ones)
    seq = max((e["eligibility_sequence"] or 0 for e in existing.values()), default=0)
    for lrid in sorted(decided):
        e = decided[lrid]
        if e["outcome_status"] == "verified":
            seq += 1
            e["eligibility_sequence"] = seq
        report[e["outcome_status"]].append(lrid)
        if e["flags"]:
            report["flagged"].append(f"{lrid}: {', '.join(e['flags'])}")
    records_obj = {**existing, **decided}
    manifest = {"verification_manifest": {"schema_version": SCHEMA_VERSION, "records": records_obj},
                "verification_manifest_sha256": sha256_jcs(records_obj)}
    return manifest, report


def eligible(entry: dict[str, Any]) -> bool:
    """Training-eligible: verified outcome AND verified temporal status AND (no flags OR provenance confirmed)."""
    return (entry["outcome_status"] == "verified" and entry["temporal_status"] == "verified"
            and (not entry["flags"] or entry["provenance_confirmed"]))
