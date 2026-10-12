"""Inference service interface + the logic every implementation shares (quality gate, pinning, provenance).

The API layer only talks to an `InferenceService`. Implementations:
  - `UnavailableService`: no verified bundle loaded → `/health/ready` false, every model endpoint 503 NOT_READY.
  - `mock.MockService`: contract mocks for parallel frontend / 3D work (model_version 0.0.0, header X-Novarion-Mock).
  - the real bundle service (Phase B) loads `artifacts/models/vX.Y.Z` behind the same interface.
"""

from __future__ import annotations

import json
from abc import ABC, abstractmethod
from collections.abc import Callable
from pathlib import Path
from typing import Any

from novarion_ml.data.canonical import BLOCK, CanonicalResult, canonicalize_case
from novarion_ml.data.registry import default_registry

from .errors import ApiError
from .schemas import (
    AnalyzeFullRequest,
    AnalyzeFullResponse,
    EvaluationResponse,
    EvidenceRequest,
    EvidenceResponse,
    ExplainRequest,
    ExplanationResponse,
    FeatureSpec,
    GlobalImportanceResponse,
    GroundTruthResponse,
    HealthReady,
    MetaResponse,
    ModelReportResponse,
    ModelsResponse,
    PatientBundle,
    PatientListResponse,
    PinnedTargetRequest,
    PredictionResponse,
    PredictRequest,
    Provenance,
    QualityCounts,
    QualityItem,
    ReplayResponse,
    ValidateRequest,
    ValidateResponse,
)

ExpectedHash = Callable[[int], str | None]


class InferenceService(ABC):
    is_mock = False

    @abstractmethod
    def ready(self) -> HealthReady: ...

    @abstractmethod
    def meta(self) -> MetaResponse: ...

    @abstractmethod
    def validate(self, req: ValidateRequest) -> ValidateResponse: ...

    @abstractmethod
    def predict(self, req: PredictRequest) -> PredictionResponse: ...

    @abstractmethod
    def analyze_full(self, req: AnalyzeFullRequest) -> AnalyzeFullResponse: ...

    @abstractmethod
    def explain(self, req: ExplainRequest) -> ExplanationResponse: ...

    @abstractmethod
    def evidence(self, req: EvidenceRequest) -> EvidenceResponse: ...

    @abstractmethod
    def patients(self) -> PatientListResponse: ...

    @abstractmethod
    def patient(self, patient_id: str) -> PatientBundle: ...

    @abstractmethod
    def ground_truth(self, patient_id: str) -> GroundTruthResponse: ...

    @abstractmethod
    def evaluation(self) -> EvaluationResponse: ...

    @abstractmethod
    def global_importance(self, target: str) -> GlobalImportanceResponse: ...

    @abstractmethod
    def models(self) -> ModelsResponse: ...

    @abstractmethod
    def model_report(self, version: str) -> ModelReportResponse: ...

    @abstractmethod
    def replay(self) -> ReplayResponse: ...


class UnavailableService(InferenceService):
    """Fail closed: without a verified bundle nothing but the health endpoints answers."""

    def __init__(self, reason: str = "No verified model bundle is loaded."):
        self.reason = reason

    def ready(self) -> HealthReady:
        return HealthReady(ready=False, reason=self.reason)

    def _not_ready(self, *_args, **_kwargs):
        raise ApiError("NOT_READY", "Prediction service is not ready.", {"reason": self.reason})

    meta = validate = predict = analyze_full = explain = evidence = _not_ready
    patients = patient = ground_truth = evaluation = global_importance = models = model_report = replay = _not_ready


# ------------------------------------------------------------------------------------------------ shared logic
def _event_summary(e: dict[str, Any]) -> str:
    d = e["details"]
    if e["event"] == "verify_outcomes":
        c = d.get("counts", {})
        return (f"Steward verification: {c.get('verified', 0)} verified, {c.get('rejected', 0)} rejected, "
                f"{c.get('conflicted', 0)} conflicted, {c.get('pending_no_attestation', 0)} left pending")
    if e["event"] == "candidate":
        return f"Candidate v{d.get('candidate')} gated against production v{d.get('champion')}: {d.get('gate_status')}"
    if e["event"] == "promote":
        return f"v{d.get('candidate')} promoted to production by a human approver (previous v{d.get('previous_production')})"
    if e["event"] == "reject":
        return f"Candidate v{d.get('candidate')} rejected by a human reviewer (gate {d.get('gate_status')})"
    return f"Production restored to v{d.get('restored')} (from v{d.get('previous_production')})"


def lifecycle_view(registry_dir: Path) -> dict[str, Any]:
    """Model Center counts + recent lifecycle events from registry/ (verification manifest + hash-chained log)."""
    from novarion_ml.lifecycle.log import LifecycleLog, LogIntegrityError
    from novarion_ml.lifecycle.verify import eligible

    manifest_path = registry_dir / "verification_manifest.json"
    records = (json.loads(manifest_path.read_text(encoding="utf-8"))["verification_manifest"]["records"].values()
               if manifest_path.exists() else [])
    log = LifecycleLog(registry_dir / "lifecycle_log.jsonl")
    try:
        entries = log.verify()
        status = "intact" if entries else "empty"
    except LogIntegrityError:
        entries, status = [], "broken"
    events = [{"seq": e["seq"], "timestamp": e["timestamp"], "event": e["event"], "summary": _event_summary(e),
               "entry_hash": e["entry_hash"]} for e in reversed(entries[-20:])]
    return {"verified_new_cases": sum(r["outcome_status"] == "verified" for r in records),
            "eligible_cases": sum(eligible(r) for r in records), "pending_cases": 0,
            "lifecycle_log_status": status, "lifecycle_events": events}


def gate_report(registry: dict[str, Any], version: str, root: Path) -> ModelReportResponse:
    entry = next((m for m in registry["models"] if m["version"] == version), None)
    path = root / (entry.get("candidate_path") or entry["path"]) / "gate_report.json" if entry else None
    if path is None or not path.exists():
        raise ApiError("NOT_FOUND", f"No gate report for version {version}.")
    doc = json.loads(path.read_text(encoding="utf-8"))
    rep = doc["report"]
    keys = ("evaluable", "auc_champion", "auc_challenger", "delta_auc_ci95", "brier_champion", "brier_challenger",
            "delta_brier_ci95", "cal_slope_ci95", "rules")
    return ModelReportResponse(version=version, champion_version=rep["champion_version"],
                               gate_status=rep["gate_status"], gate_report_sha256=doc["gate_report_sha256"],
                               targets={t: {k: r[k] for k in keys} for t, r in rep["targets"].items()})


def replay_study(registry_dir: Path) -> ReplayResponse:
    path = registry_dir / "replay.json"
    if not path.exists():
        raise ApiError("NOT_FOUND", "The replay study has not been run (scripts/replay.py).")
    return ReplayResponse.model_validate(json.loads(path.read_text(encoding="utf-8")))


def feature_specs() -> list[FeatureSpec]:
    """Registry → /meta feature specs (one builder for every service implementation)."""
    specs = []
    for f in default_registry().features:
        tokens = {str(k): v for k, v in f.source_tokens.items()}
        if f.kind != "binary":
            tokens.update({c: c for c in f.categories})
        specs.append(FeatureSpec(
            id=f.id, display=f.display, group=f.group, kind=f.kind, categories=list(f.categories),
            canonical_unit=f.canonical_unit, unit_unambiguous=f.unit_unambiguous, display_precision=f.display_precision,
            hard_valid_range=list(f.hard_valid_range) if f.hard_valid_range else None, allow_unknown=f.allow_unknown,
            editable=f.editable, immutable_in_whatif=f.immutable_in_whatif, input_mode=f.input_mode,
            constant_value=f.constant_value, aliases=list(f.aliases), import_tokens=tokens,
        ))
    return specs


def leakage_denylist() -> list[str]:
    return sorted(default_registry().leakage_denylist)


def quality_items(result: CanonicalResult) -> list[QualityItem]:
    return [
        QualityItem(code=i.code, severity=i.severity, feature_id=i.feature_id, message=i.message, details=i.details)
        for i in result.issues
    ]


def quality_counts(req: ValidateRequest | PredictRequest, result: CanonicalResult) -> QualityCounts:
    registry = default_registry()
    unknown = registry.unknown_token
    entered = {f.id for f in registry.features if f.input_mode == "entered"}
    provided = {k for k, v in req.inputs.items() if k in entered and v is not None and str(v).strip() != ""}
    codes = [i.code for i in result.issues]
    return QualityCounts(
        recognized=len(provided),
        unknown=sum(1 for k in provided if isinstance(req.inputs[k], str) and req.inputs[k].strip() == unknown),
        out_of_range=codes.count("out_of_hard_range"),
        missing_required=codes.count("missing_required"),
    )


def build_validate_response(req: ValidateRequest, expected_hash: ExpectedHash) -> ValidateResponse:
    """Registry-level quality gate + dataset provenance (bundle-level checks are appended by the real service)."""
    result = canonicalize_case(req.inputs, req.unit_status)
    items = quality_items(result)
    provenance = Provenance(prediction_mode="final_model")
    if req.dataset_record_id is not None:
        expected = expected_hash(req.dataset_record_id)
        if expected is None:
            provenance = Provenance(
                dataset_record_id=req.dataset_record_id, prediction_mode="final_model",
                message="Unknown dataset record; analysed as a new case with the final model.",
            )
        elif result.input_sha256 == expected:
            provenance = Provenance(
                dataset_record_id=req.dataset_record_id, trusted_record=True, input_hash_match=True,
                prediction_mode="oof", message="Matches the dataset record; out-of-fold result available.",
            )
        else:
            provenance = Provenance(
                dataset_record_id=req.dataset_record_id, trusted_record=True, input_hash_match=False,
                prediction_mode="final_model",
                message="Values differ from the dataset record; analysed as a new case with the final model.",
            )
            if result.ready:
                items.append(QualityItem(
                    code="dataset_record_mismatch", severity="WARN", feature_id=None,
                    message="Values differ from the referenced dataset record; the out-of-fold result does not apply.",
                ))
    return ValidateResponse(
        request_id=req.request_id, input_revision=req.input_revision, ready=result.ready,
        input_sha256=result.input_sha256, canonical_inputs=result.canonical, items=items,
        counts=quality_counts(req, result), provenance=provenance,
    )


def canonical_or_block(req: PredictRequest) -> CanonicalResult:
    """The server is authoritative: a case with any BLOCK item never reaches a model."""
    result = canonicalize_case(req.inputs, req.unit_status)
    if not result.ready:
        blocks = [i.model_dump(mode="json") for i in quality_items(result) if i.severity == BLOCK]
        raise ApiError("QUALITY_GATE_BLOCKED", "Inputs did not pass the data-quality gate.", {"items": blocks[:50]})
    return result


def check_pinned(req: PinnedTargetRequest, model_version: str, artifact_manifest_sha256: str) -> CanonicalResult:
    """/explain and /evidence: recompute the hash; never explain with a different bundle (plan §11)."""
    result = canonical_or_block(req)
    if result.input_sha256 != req.input_sha256:
        raise ApiError("INPUT_HASH_MISMATCH", "inputs do not match input_sha256.", {"recomputed": result.input_sha256})
    if req.artifact_manifest_sha256 != artifact_manifest_sha256 or req.model_version != model_version:
        raise ApiError(
            "ARTIFACT_MISMATCH", "The pinned model bundle is not the loaded bundle.",
            {"loaded_model_version": model_version, "loaded_artifact_manifest_sha256": artifact_manifest_sha256},
        )
    return result
