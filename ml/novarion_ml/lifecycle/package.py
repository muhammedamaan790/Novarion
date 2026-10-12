"""Learning package: the browser's "Export learning package" file (plan §12B pipeline, §12A CaseStore outcomes).

Strict allowlist: any field outside it rejects the whole package (no review notes, reviewer identity, free-form
provenance, timestamps or direct identifiers can ride along). Outcome status in case JSON is NEVER trusted: whatever
it says, every outcome read here is `pending` until `make verify-outcomes` decides.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any

from ..data.canonical import canonicalize_case, input_sha256
from ..data.registry import Registry, default_registry, load_targets

PACKAGE_KIND = "novarion_learning_package"
PACKAGE_SCHEMA_VERSION = "1.0.0"
TARGETS = ("cad", "lad", "lcx", "rca")
SOURCE_TYPES = ("angiography_report", "catheterization_lab_record", "research_registry")
SOURCE_SYSTEMS = ("hospital_ehr", "research_database", "other_documented")
CORRECTION_REASONS = ("data_entry_error", "updated_source", "label_definition_mismatch")

PACKAGE_FIELDS = {"kind", "package_schema_version", "records"}
RECORD_FIELDS = {"learning_record_id", "case_source", "outcomes"}
OUTCOME_FIELDS = {"outcome_id", "applies_to_input_sha256", "inputs", "labels", "label_definition", "source_type",
                  "source_system", "pseudonymous_study_id", "supersedes_outcome_id", "correction_reason",
                  "outcome_status"}


class PackageError(ValueError):
    pass


@dataclass
class Outcome:
    outcome_id: str
    input_sha256: str
    inputs: dict[str, Any]
    labels: dict[str, int]
    label_definition: dict[str, str]
    source_type: str
    source_system: str
    pseudonymous_study_id: str | None
    supersedes_outcome_id: str | None
    correction_reason: str | None
    problems: list[str] = field(default_factory=list)  # automated eligibility checks that failed

    @property
    def label_hash(self) -> str:
        return label_hash(self.labels)


@dataclass
class PackageRecord:
    learning_record_id: str
    case_source: str
    outcomes: dict[str, Outcome]  # by outcome_id (re-exports of the same record merge here)


def label_hash(labels: dict[str, int]) -> str:
    import rfc8785

    return hashlib.sha256(rfc8785.dumps(labels)).hexdigest()


def label_definitions() -> dict[str, str]:
    return {t["id"]: t["label_definition"] for t in load_targets()["targets"]}


def _extra(obj: dict, allowed: set[str], where: str) -> None:
    extra = set(obj) - allowed
    if extra:
        raise PackageError(f"{where}: fields outside the learning-package allowlist: {sorted(extra)}")


def _outcome(raw: dict[str, Any], registry: Registry, definitions: dict[str, str]) -> Outcome:
    _extra(raw, OUTCOME_FIELDS, f"outcome {raw.get('outcome_id')}")
    problems = []
    labels = raw.get("labels") or {}
    if set(labels) != set(TARGETS) or any(v not in (0, 1) or isinstance(v, bool) for v in labels.values()):
        problems.append("labels must give 0/1 for cad, lad, lcx and rca")
    if raw.get("label_definition") != definitions:
        problems.append("label definition does not match the dataset definitions (config/targets.yaml)")
    if raw.get("source_type") not in SOURCE_TYPES:
        problems.append(f"source_type must be one of {SOURCE_TYPES}")
    if raw.get("source_system") not in SOURCE_SYSTEMS:
        problems.append(f"source_system must be one of {SOURCE_SYSTEMS}")
    if raw.get("supersedes_outcome_id") and raw.get("correction_reason") not in CORRECTION_REASONS:
        problems.append("a correction needs correction_reason")
    inputs = raw.get("inputs") or {}
    ids = [f.id for f in registry.features]
    if set(inputs) != set(ids):
        problems.append("inputs must be the complete canonical feature vector")
    elif any(v == registry.unknown_token for v in inputs.values()):
        problems.append("training examples need complete inputs (no Unknown values)")
    else:
        entered = {f.id: inputs[f.id] for f in registry.features if f.input_mode == "entered"}
        result = canonicalize_case(entered, registry=registry)
        if result.canonical != {fid: inputs[fid] for fid in ids}:
            problems.append("inputs are not a valid canonical case (re-canonicalization differs)")
    if input_sha256(inputs) != raw.get("applies_to_input_sha256"):
        problems.append("applies_to_input_sha256 does not match the inputs")
    return Outcome(str(raw.get("outcome_id")), str(raw.get("applies_to_input_sha256")), inputs,
                   {t: labels.get(t) for t in TARGETS}, raw.get("label_definition") or {}, str(raw.get("source_type")),
                   str(raw.get("source_system")), raw.get("pseudonymous_study_id"), raw.get("supersedes_outcome_id"),
                   raw.get("correction_reason"), problems)


def load_package(text: str, registry: Registry | None = None) -> tuple[dict[str, PackageRecord], list[str]]:
    """Parse + structurally validate. Returns (records by learning_record_id, notes). Raises PackageError."""
    registry = registry or default_registry()
    definitions = label_definitions()
    try:
        raw = json.loads(text)
    except json.JSONDecodeError as e:
        raise PackageError(f"not JSON: {e}") from e
    if not isinstance(raw, dict) or raw.get("kind") != PACKAGE_KIND:
        raise PackageError("not a NOVARION learning package")
    _extra(raw, PACKAGE_FIELDS, "package")
    if raw.get("package_schema_version") != PACKAGE_SCHEMA_VERSION:
        raise PackageError(f"unsupported package_schema_version {raw.get('package_schema_version')!r}")
    records: dict[str, PackageRecord] = {}
    notes: list[str] = []
    for r in raw.get("records") or []:
        _extra(r, RECORD_FIELDS, f"record {r.get('learning_record_id')}")
        lrid = str(r.get("learning_record_id") or "")
        if not lrid:
            raise PackageError("record without learning_record_id")
        if r.get("case_source") == "dataset":
            notes.append(f"{lrid}: dataset-library case excluded (already training data)")
            continue
        rec = records.setdefault(lrid, PackageRecord(lrid, str(r.get("case_source")), {}))
        for o in r.get("outcomes") or []:
            if o.get("outcome_status") not in (None, "pending"):
                notes.append(f"{lrid}: outcome {o.get('outcome_id')} claims status {o.get('outcome_status')!r}; "
                             "ignored (only make verify-outcomes can verify)")
            outcome = _outcome(o, registry, definitions)
            previous = rec.outcomes.get(outcome.outcome_id)
            if previous is not None and previous.__dict__ != outcome.__dict__:
                raise PackageError(f"{lrid}: outcome {outcome.outcome_id} appears twice with different content")
            rec.outcomes[outcome.outcome_id] = outcome
    return records, notes


def active_outcomes(record: PackageRecord) -> list[Outcome]:
    """Latest non-superseded outcomes (corrections append; nothing is mutated)."""
    superseded = {o.supersedes_outcome_id for o in record.outcomes.values() if o.supersedes_outcome_id}
    return sorted((o for o in record.outcomes.values() if o.outcome_id not in superseded), key=lambda o: o.outcome_id)
