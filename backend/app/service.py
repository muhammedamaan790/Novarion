"""Inference service interface + the logic every implementation shares (quality gate, pinning, provenance).

The API layer only talks to an `InferenceService`. Implementations:
  - `UnavailableService`: no verified bundle loaded → `/health/ready` false, every model endpoint 503 NOT_READY.
  - `mock.MockService`: contract mocks for parallel frontend / 3D work (model_version 0.0.0, header X-Novarion-Mock).
  - the real bundle service (Phase B) loads `artifacts/models/vX.Y.Z` behind the same interface.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Callable

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


class UnavailableService(InferenceService):
    """Fail closed: without a verified bundle nothing but the health endpoints answers."""

    def __init__(self, reason: str = "No verified model bundle is loaded."):
        self.reason = reason

    def ready(self) -> HealthReady:
        return HealthReady(ready=False, reason=self.reason)

    def _not_ready(self, *_args, **_kwargs):
        raise ApiError("NOT_READY", "Prediction service is not ready.", {"reason": self.reason})

    meta = validate = predict = analyze_full = explain = evidence = _not_ready
    patients = patient = ground_truth = evaluation = global_importance = models = model_report = _not_ready


# ------------------------------------------------------------------------------------------------ shared logic
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
