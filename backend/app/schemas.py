"""NOVARION API contract v1 (plan §11, §11A). Source of truth → contracts/openapi.json → frontend types.

Every model forbids extra fields and non-finite numbers. Validators enforce the plan's invariants so a response
that breaks them cannot be constructed (e.g., additivity of explanations, confidence/region consistency, the
symmetric confidence schema, and that a rejected analysis carries no prediction values).
"""

from __future__ import annotations

import math
import re
import uuid
from typing import Annotated, Any, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictFloat,
    StrictInt,
    StrictStr,
    field_validator,
    model_validator,
)

from novarion_ml.data.canonical import entered_features
from novarion_ml.data.registry import default_registry

API_SCHEMA_VERSION = "1.0.0"
DISCLAIMER = "Decision support / educational purposes only. Not a substitute for formal diagnostic imaging."
CAUSAL_CAPTION = (
    "Contributions describe how this model used the inputs: associations learned from this cohort, not causes."
)

TargetId = Literal["cad", "lad", "lcx", "rca"]
TARGET_IDS: tuple[str, ...] = ("cad", "lad", "lcx", "rca")
PresentationGroup = Literal["demographics", "history", "symptoms_exam", "ecg", "labs", "echo"]
PredictionMode = Literal["oof", "final_model"]
Sha256 = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
Probability = Annotated[float, Field(ge=0.0, le=1.0, allow_inf_nan=False)]
Finite = Annotated[float, Field(allow_inf_nan=False)]
ShortStr = Annotated[str, Field(max_length=256)]
PatientId = Annotated[str, Field(pattern=r"^ZAS-\d{4}$")]
SemVer = Annotated[str, Field(pattern=r"^\d+\.\d+\.\d+$")]
InputValue = StrictInt | StrictFloat | StrictStr | None

CONFIDENCE_REASON_ORDER = ("unknown_input", "atypical_profile", "unstable", "no_validation_evidence",
                           "no_qualified_region", "gray_zone")
ConfidenceReason = Literal["unknown_input", "atypical_profile", "unstable", "no_validation_evidence",
                           "no_qualified_region", "gray_zone"]

ADDITIVITY_RTOL, ADDITIVITY_ATOL = 1e-6, 1e-5


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False, str_max_length=256)


def _check_targets_complete(mapping: dict[str, Any], what: str) -> None:
    if set(mapping) != set(TARGET_IDS):
        raise ValueError(f"{what} must contain exactly the targets {TARGET_IDS}")


# ---------------------------------------------------------------------------------------------------- errors
ErrorCode = Literal[
    "VALIDATION_FAILED", "INPUT_OUT_OF_RANGE", "UNSEEN_CATEGORY", "UNIT_MISMATCH", "INPUT_HASH_MISMATCH",
    "ARTIFACT_MISMATCH", "NOT_READY", "TARGET_FAILED", "PAYLOAD_TOO_LARGE", "RATE_LIMITED", "NOT_FOUND",
    "QUALITY_GATE_BLOCKED", "INTERNAL_ERROR", "FORBIDDEN", "PROMOTION_REFUSED", "UNAUTHENTICATED",
    "INVALID_CREDENTIALS",
]
TargetStatusValue = Literal["complete", "computed_not_committed", "error"]


class ErrorResponse(Strict):
    """The one error envelope for every endpoint. A rejected analysis carries NO prediction values (by schema)."""

    error_code: ErrorCode
    message: ShortStr
    details: dict[str, Any] = Field(default_factory=dict)
    request_id: uuid.UUID | None = None
    api_schema_version: str = API_SCHEMA_VERSION
    commit_status: Literal["rejected"] | None = None
    prediction_status: Literal["unavailable"] | None = None
    target_status: dict[TargetId, TargetStatusValue] | None = None

    @model_validator(mode="after")
    def _partial_failure_shape(self) -> ErrorResponse:
        if self.error_code == "TARGET_FAILED":
            if self.commit_status != "rejected" or self.prediction_status != "unavailable" or not self.target_status:
                raise ValueError("TARGET_FAILED requires commit_status=rejected, prediction_status=unavailable, target_status")
            _check_targets_complete(self.target_status, "target_status")
            if "error" not in self.target_status.values():
                raise ValueError("TARGET_FAILED requires at least one target in error")
            if "complete" in self.target_status.values():
                raise ValueError("in a rejected analysis no target may be 'complete' (use computed_not_committed)")
        return self


# ---------------------------------------------------------------------------------------------------- requests
class _CaseInputs(Strict):
    request_id: uuid.UUID
    api_schema_version: str
    inputs: dict[str, InputValue] = Field(max_length=100)
    unit_status: dict[str, Literal["explicit", "canonical_assumed"]] = Field(default_factory=dict, max_length=100)

    @field_validator("api_schema_version")
    @classmethod
    def _compatible_schema(cls, v: str) -> str:
        if v.split(".")[0] != API_SCHEMA_VERSION.split(".")[0]:
            raise ValueError(f"incompatible api_schema_version {v!r} (server {API_SCHEMA_VERSION})")
        return v

    @field_validator("inputs")
    @classmethod
    def _allowlisted_features(cls, v: dict[str, Any]) -> dict[str, Any]:
        registry = default_registry()
        allowed = {f.id for f in registry.features}
        unknown = sorted(set(v) - allowed)
        if unknown:
            raise ValueError(f"unknown feature ids (only registry features are accepted): {unknown}")
        for key, value in v.items():
            if isinstance(value, float) and not math.isfinite(value):
                raise ValueError(f"{key}: non-finite numbers are not allowed")
        return v

    @field_validator("unit_status")
    @classmethod
    def _unit_status_on_continuous(cls, v: dict[str, str]) -> dict[str, str]:
        continuous = {f.id for f in default_registry().features if f.kind == "continuous" and f.input_mode == "entered"}
        bad = sorted(set(v) - continuous)
        if bad:
            raise ValueError(f"unit_status only applies to entered continuous features, not {bad}")
        return v


class ValidateRequest(_CaseInputs):
    """Quality gate. Blank (null) or missing values are reported as BLOCK items, not rejected with 422."""

    input_revision: StrictInt = Field(ge=0)
    dataset_record_id: StrictInt | None = Field(default=None, ge=0)


class PredictRequest(_CaseInputs):
    """Fast path. Strict: every entered feature must have a value or the UNKNOWN token."""

    input_revision: StrictInt = Field(ge=0)

    @model_validator(mode="after")
    def _complete(self) -> PredictRequest:
        registry = default_registry()
        missing = sorted(f.id for f in entered_features(registry) if self.inputs.get(f.id) is None)
        if missing:
            raise ValueError(f"missing required features (supply a value or {registry.unknown_token!r}): {missing}")
        return self


class AnalyzeFullRequest(PredictRequest):
    """Persistence path: predictions + all 4 explanations + evidence on one bundle handle; all-or-nothing."""

    input_revision: StrictInt = Field(default=0, ge=0)
    dataset_record_id: StrictInt | None = Field(default=None, ge=0)


class PinnedTargetRequest(PredictRequest):
    """/explain and /evidence: transient analyses only, pinned to the loaded bundle (409 on mismatch)."""

    input_revision: StrictInt = Field(default=0, ge=0)
    analysis_id: uuid.UUID
    input_sha256: Sha256
    target: TargetId
    model_version: SemVer
    artifact_manifest_sha256: Sha256


class ExplainRequest(PinnedTargetRequest):
    pass


class EvidenceRequest(PinnedTargetRequest):
    pass


class SensitivityRequest(PinnedTargetRequest):
    """Tier-3 what-if (ICE) for one target of a transient final-model analysis, pinned like /explain."""


# ---------------------------------------------------------------------------------------------------- health / meta
class HealthLive(Strict):
    status: Literal["ok"] = "ok"


# ---------------------------------------------------------------------------------------------------- sign-in (D-022)
class LoginRequest(Strict):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=256)


class AuthSession(Strict):
    """auth_required=false: no accounts file, so the API is open (dev, tests). user=null: not signed in."""

    auth_required: bool
    accounts_configured: bool
    user: str | None = None


class HealthReady(Strict):
    ready: bool
    reason: ShortStr | None = None
    model_version: SemVer | None = None
    artifact_manifest_sha256: Sha256 | None = None

    @model_validator(mode="after")
    def _reason_when_not_ready(self) -> HealthReady:
        if not self.ready and not self.reason:
            raise ValueError("a reason is required when ready is false")
        return self


class FeatureSpec(Strict):
    id: str
    display: str
    group: PresentationGroup
    kind: Literal["binary", "ordinal", "nominal", "continuous"]
    categories: list[str] = Field(default_factory=list)
    canonical_unit: str | None = None
    unit_unambiguous: bool | None = None
    display_precision: int | None = None
    hard_valid_range: list[Finite] | None = None
    allow_unknown: bool
    editable: bool
    immutable_in_whatif: bool
    input_mode: Literal["entered", "computed", "constant"]
    constant_value: StrictInt | StrictFloat | StrictStr | None = None
    aliases: list[str] = Field(default_factory=list)  # accepted import column names (exact match only)
    import_tokens: dict[str, StrictInt | StrictStr] = Field(default_factory=dict)  # source token → canonical value


class TargetSpec(Strict):
    id: TargetId
    display: str
    anatomy_key: str
    label_definition: str


class Thresholds(Strict):
    t_op: Probability
    t_neg: Probability | None
    t_pos: Probability | None

    @model_validator(mode="after")
    def _ordered(self) -> Thresholds:
        if self.t_neg is not None and self.t_neg > self.t_op:
            raise ValueError("t_neg must be <= t_op")
        if self.t_pos is not None and self.t_pos < self.t_op:
            raise ValueError("t_pos must be >= t_op")
        return self


class MetaResponse(Strict):
    app_version: SemVer
    api_schema_version: str = API_SCHEMA_VERSION
    model_version: SemVer
    preprocessing_version: SemVer
    run_mode: Literal["live", "local"]
    promote_available: bool
    unknown_token: str
    targets: list[TargetSpec]
    features: list[FeatureSpec]
    thresholds: dict[TargetId, Thresholds]
    anatomy_version: SemVer
    anatomy_asset_sha256: Sha256
    anatomy_map: dict[str, Any]
    evidence_bands: list[list[Probability]]
    leakage_denylist: list[str] = Field(default_factory=list)  # label columns an import must drop (plan §5.4)
    disclaimer: str = DISCLAIMER

    @model_validator(mode="after")
    def _all_targets(self) -> MetaResponse:
        _check_targets_complete(self.thresholds, "thresholds")
        if {t.id for t in self.targets} != set(TARGET_IDS):
            raise ValueError("targets must list cad, lad, lcx, rca")
        if self.promote_available and self.run_mode != "local":
            raise ValueError("promotion is only available in local mode")
        return self


# ---------------------------------------------------------------------------------------------------- quality
Severity = Literal["BLOCK", "WARN", "INFO"]


class QualityItem(Strict):
    code: Literal[
        "missing_required", "unknown_not_allowed", "invalid_type", "out_of_hard_range", "cross_field_violation",
        "unseen_category", "unit_unknown", "canonical_assumed_unit", "unknown_input", "computed_value_mismatch",
        "outside_training_range", "atypical_profile", "exact_training_match", "dataset_record_mismatch",
        "constant_feature_ignored",
    ]
    severity: Severity
    feature_id: str | None = None
    message: ShortStr
    details: dict[str, Any] = Field(default_factory=dict)


class QualityCounts(Strict):
    recognized: StrictInt = Field(ge=0)
    unknown: StrictInt = Field(ge=0)
    out_of_range: StrictInt = Field(ge=0)
    missing_required: StrictInt = Field(ge=0)


class Provenance(Strict):
    dataset_record_id: StrictInt | None = None
    trusted_record: bool = False
    input_hash_match: bool | None = None
    prediction_mode: PredictionMode
    message: ShortStr | None = None

    @model_validator(mode="after")
    def _oof_only_if_trusted_match(self) -> Provenance:
        if self.prediction_mode == "oof" and not (self.trusted_record and self.input_hash_match):
            raise ValueError("OOF mode requires a trusted dataset_record_id whose expected_input_sha256 matches")
        return self


class ValidateResponse(Strict):
    request_id: uuid.UUID
    api_schema_version: str = API_SCHEMA_VERSION
    input_revision: StrictInt = Field(ge=0)
    ready: bool
    input_sha256: Sha256 | None
    canonical_inputs: dict[str, StrictInt | StrictFloat | StrictStr] | None
    items: list[QualityItem]
    counts: QualityCounts
    provenance: Provenance

    @model_validator(mode="after")
    def _consistency(self) -> ValidateResponse:
        blocked = any(i.severity == "BLOCK" for i in self.items)
        if self.ready == blocked:
            raise ValueError("ready must be true exactly when no BLOCK item exists")
        if self.ready != (self.input_sha256 is not None) or self.ready != (self.canonical_inputs is not None):
            raise ValueError("input_sha256 and canonical_inputs are present exactly when ready")
        return self


class AtypicalProfile(Strict):
    flag: bool
    distance_percentile: Annotated[float, Field(ge=0, le=100)] | None = None


class QualityNotice(Strict):
    code: Literal["exact_training_match", "derived_from_training_record", "legacy_oof_ledger_withheld"]
    message: ShortStr


class PredictionQuality(Strict):
    atypical_profile: AtypicalProfile
    out_of_range_features: list[str] = Field(default_factory=list)
    unknown_inputs: list[str] = Field(default_factory=list)
    class_conflict_note: ShortStr | None = None  # always null under D-001 (labels not strictly nested)
    notices: list[QualityNotice] = Field(default_factory=list)


# ---------------------------------------------------------------------------------------------------- predictions
class ConfidenceThresholds(Strict):
    negative_below: Probability | None
    positive_at_or_above: Probability | None


class ConfidenceQualification(Strict):
    metric: Literal["ppv", "npv"]
    target: Probability
    lower_bound: Probability
    n: StrictInt = Field(ge=1)
    source: Literal["training_side_oof"] = "training_side_oof"

    @model_validator(mode="after")
    def _qualified(self) -> ConfidenceQualification:
        if self.lower_bound < self.target:
            raise ValueError("a qualified region's Wilson lower bound must meet the pre-registered target")
        return self


class EvaluationContext(Strict):
    metric: Literal["ppv", "npv"]
    value: Probability
    ci: list[Probability] | None = Field(default=None, min_length=2, max_length=2)
    n: StrictInt = Field(ge=1)
    level: Literal["cohort"] = "cohort"
    source: Literal["prespecified_outer_repeat"] = "prespecified_outer_repeat"


class StabilityInterval(Strict):
    p10: Probability
    p90: Probability
    n_valid: StrictInt = Field(ge=80, le=100)
    label: Literal["model stability interval"] = "model stability interval"

    @model_validator(mode="after")
    def _ordered(self) -> StabilityInterval:
        if self.p10 > self.p90:
            raise ValueError("p10 must be <= p90")
        return self


class TargetPrediction(Strict):
    label: str
    anatomy_key: str
    predicted_class: Literal["positive", "negative"]
    probability: Probability
    calibrated_logit: Finite
    operating_threshold: Probability
    model_confidence: Literal["high", "low"]
    model_confidence_thresholds: ConfidenceThresholds
    model_confidence_region: Literal["high_negative", "low_confidence", "high_positive"]
    model_confidence_reasons: list[ConfidenceReason]
    confidence_qualification: ConfidenceQualification | None
    evaluation_context: EvaluationContext | None
    stability_interval: StabilityInterval | None = None

    @model_validator(mode="after")
    def _invariants(self) -> TargetPrediction:
        p, t_op = self.probability, self.operating_threshold
        th = self.model_confidence_thresholds
        if not math.isclose(1 / (1 + math.exp(-self.calibrated_logit)), p, rel_tol=1e-9, abs_tol=1e-12):
            raise ValueError("probability must equal sigmoid(calibrated_logit)")
        if (p >= t_op) != (self.predicted_class == "positive"):
            raise ValueError("Layer A: predicted_class must be positive exactly when p >= t_op")
        Thresholds(t_op=t_op, t_neg=th.negative_below, t_pos=th.positive_at_or_above)  # ordering check
        if th.positive_at_or_above is not None and p >= th.positive_at_or_above:
            region = "high_positive"
        elif th.negative_below is not None and p < th.negative_below:
            region = "high_negative"
        else:
            region = "low_confidence"
        if self.model_confidence_region != region:
            raise ValueError(f"model_confidence_region must be {region!r} for these thresholds")
        reasons = self.model_confidence_reasons
        if list(reasons) != sorted(set(reasons), key=CONFIDENCE_REASON_ORDER.index):
            raise ValueError(f"reasons must be unique and ordered {CONFIDENCE_REASON_ORDER}")
        if region == "low_confidence":
            side_missing = th.positive_at_or_above is None if p >= t_op else th.negative_below is None
            required = "no_qualified_region" if side_missing else "gray_zone"
            if required not in reasons:
                raise ValueError(f"low_confidence region requires reason {required!r}")
        elif {"gray_zone", "no_qualified_region"} & set(reasons):
            raise ValueError("gray_zone / no_qualified_region only apply inside the low-confidence region")
        if (self.model_confidence == "high") != (not reasons):
            raise ValueError("model_confidence is high exactly when there are no LOW reasons")
        # Symmetric confidence schema: metric npv for high_negative, ppv for high_positive, null for LOW.
        if self.model_confidence == "high":
            metric = "ppv" if region == "high_positive" else "npv"
            if self.confidence_qualification is None or self.evaluation_context is None:
                raise ValueError("HIGH confidence must carry confidence_qualification and evaluation_context")
            if self.confidence_qualification.metric != metric or self.evaluation_context.metric != metric:
                raise ValueError(f"metric must be {metric!r} for region {region!r}")
        elif self.confidence_qualification is not None or self.evaluation_context is not None:
            raise ValueError("LOW confidence never shows a PPV/NPV line (both must be null)")
        return self


class PatientContext(Strict):
    """Which model produced every number. The case's origin (dataset / manual / import) is owned by the frontend
    CaseStore: the stateless server cannot know it (D-007)."""

    prediction_mode: PredictionMode


class _AnalysisIdentity(Strict):
    analysis_id: uuid.UUID
    api_schema_version: str = API_SCHEMA_VERSION
    app_version: SemVer
    model_version: SemVer
    preprocessing_version: SemVer
    anatomy_version: SemVer
    anatomy_asset_sha256: Sha256
    input_sha256: Sha256
    training_data_sha256: Sha256
    artifact_manifest_sha256: Sha256
    reference_context_sha256: Sha256  # SHA-256(JCS({target_id: reference_context_sha256})) for the 4 targets used
    commit_status: Literal["committed"] = "committed"
    prediction_status: Literal["complete"] = "complete"
    target_status: dict[TargetId, Literal["complete"]]
    patient: PatientContext
    quality: PredictionQuality
    targets: dict[TargetId, TargetPrediction]
    disclaimer: str = DISCLAIMER

    @model_validator(mode="after")
    def _all_four_committed(self) -> _AnalysisIdentity:
        _check_targets_complete(self.targets, "targets")  # fail closed: all four or nothing
        _check_targets_complete(self.target_status, "target_status")
        for tid, pred in self.targets.items():
            if self.quality.unknown_inputs and "unknown_input" not in pred.model_confidence_reasons:
                raise ValueError(f"{tid}: UNKNOWN inputs force LOW confidence (reason unknown_input)")
            if self.quality.atypical_profile.flag and "atypical_profile" not in pred.model_confidence_reasons:
                raise ValueError(f"{tid}: an atypical profile forces LOW confidence (reason atypical_profile)")
            if pred.stability_interval is not None and self.patient.prediction_mode != "oof":
                raise ValueError("stability intervals exist for dataset (OOF) patients only")
        return self


class PredictionResponse(_AnalysisIdentity):
    """/predict fast path: no SHAP, no evidence, no similarity."""

    request_id: uuid.UUID
    input_revision: StrictInt = Field(ge=0)


# ---------------------------------------------------------------------------------------------------- explanations
class GroupStat(Strict):
    n: StrictInt = Field(ge=0)
    status: Literal["ok", "insufficient_evidence"]
    percentile: Annotated[float, Field(ge=0, le=100)] | None = None
    rate: Probability | None = None


class CohortComparison(Strict):
    type: Literal["percentile", "binary_prevalence", "category_frequency"]
    value: StrictInt | StrictFloat | StrictStr | None = None
    negative: GroupStat
    positive: GroupStat

    @model_validator(mode="after")
    def _typed(self) -> CohortComparison:
        for side in (self.negative, self.positive):
            has = side.percentile if self.type == "percentile" else side.rate
            other = side.rate if self.type == "percentile" else side.percentile
            if other is not None:
                raise ValueError(f"{self.type} comparison uses {'percentile' if self.type == 'percentile' else 'rate'} only")
            if side.status == "ok" and (has is None or side.n < 20):
                raise ValueError("an 'ok' comparison needs a value and n >= cohort_comparison_min_n (20)")
            if side.status == "insufficient_evidence" and has is not None:
                raise ValueError("insufficient evidence never shows a rate or percentile")
        return self


class Imputation(Strict):
    method: Literal["median", "mode"]
    value: StrictInt | StrictFloat | StrictStr
    fit_scope: Literal["fold_outer_training", "full_cohort"]


class Contribution(Strict):
    feature: str
    display: str
    value: StrictInt | StrictFloat | StrictStr
    display_value: ShortStr
    contribution: Finite
    direction: Literal["up", "down", "neutral"]
    strength: Literal["slight", "moderate", "strong"]
    group: PresentationGroup
    value_status: Literal["provided", "imputed", "computed", "derived"]
    imputation: Imputation | None = None
    relative_share: Annotated[float, Field(ge=0, le=1)] | None
    cohort_comparison: CohortComparison | None = None

    @model_validator(mode="after")
    def _coherent(self) -> Contribution:
        expected = "up" if self.contribution > 0 else "down" if self.contribution < 0 else "neutral"
        if self.direction != expected:
            raise ValueError(f"{self.feature}: direction must be {expected!r}")
        if (self.value_status == "imputed") != (self.imputation is not None):
            raise ValueError(f"{self.feature}: imputation provenance is present exactly for imputed values")
        if self.value_status == "imputed" and self.cohort_comparison is not None:
            raise ValueError(f"{self.feature}: no cohort comparison for an imputed (unmeasured) value")
        return self


class StrengthCutpoints(Strict):
    q1: Annotated[float, Field(ge=0, allow_inf_nan=False)]
    q2: Annotated[float, Field(ge=0, allow_inf_nan=False)]


class GroupContribution(Strict):
    contribution: Finite
    strength: Literal["slight", "moderate", "strong"]


class ExplanationPayload(Strict):
    target: TargetId
    space: Literal["calibrated_log_odds"] = "calibrated_log_odds"
    base_calibrated_logit: Finite
    calibrated_logit: Finite
    contributions: list[Contribution] = Field(min_length=1)
    groups: dict[PresentationGroup, GroupContribution]
    strength_cutpoints: StrengthCutpoints
    caption: str = CAUSAL_CAPTION

    @model_validator(mode="after")
    def _additive_sorted_bucketed(self) -> ExplanationPayload:
        total = self.base_calibrated_logit + math.fsum(c.contribution for c in self.contributions)
        if not math.isclose(total, self.calibrated_logit, rel_tol=ADDITIVITY_RTOL, abs_tol=ADDITIVITY_ATOL):
            raise ValueError("additivity: base_calibrated_logit + sum(contributions) must equal calibrated_logit")
        key = [(-abs(c.contribution), c.feature) for c in self.contributions]
        if key != sorted(key):
            raise ValueError("contributions must be sorted by |contribution| desc, then feature id asc")
        if len({c.feature for c in self.contributions}) != len(self.contributions):
            raise ValueError("one contribution per registry feature (aggregate one-hot columns first)")
        mass = math.fsum(abs(c.contribution) for c in self.contributions)
        for c in self.contributions:
            expected = None if mass == 0 else abs(c.contribution) / mass
            if (expected is None) != (c.relative_share is None) or (
                expected is not None and not math.isclose(expected, c.relative_share, abs_tol=1e-9)
            ):
                raise ValueError(f"{c.feature}: relative_share must be |c| / sum|c| (null when the sum is 0)")
            q1, q2 = self.strength_cutpoints.q1, self.strength_cutpoints.q2
            mag = abs(c.contribution)
            bucket = "slight" if mag <= q1 else "moderate" if mag <= q2 else "strong"
            if c.strength != bucket:
                raise ValueError(f"{c.feature}: strength must be {bucket!r} for the stored cut points")
        group_sums: dict[str, float] = {}
        for c in self.contributions:
            group_sums[c.group] = group_sums.get(c.group, 0.0) + c.contribution
        for g, stat in self.groups.items():
            if not math.isclose(stat.contribution, group_sums.get(g, 0.0), rel_tol=1e-9, abs_tol=1e-9):
                raise ValueError(f"group {g}: contribution must be the sum of its features")
        if set(self.groups) != set(group_sums):
            raise ValueError("groups must cover exactly the groups present in contributions")
        return self


class ExplanationResponse(ExplanationPayload):
    analysis_id: uuid.UUID
    request_id: uuid.UUID
    api_schema_version: str = API_SCHEMA_VERSION
    model_version: SemVer
    artifact_manifest_sha256: Sha256
    prediction_mode: PredictionMode


# ---------------------------------------------------------------------------------------------------- evidence
class SimilarPatient(Strict):
    patient_id: PatientId
    rank: StrictInt = Field(ge=1)
    distance: Annotated[float, Field(ge=0, le=1)]
    labels: dict[TargetId, Literal[0, 1]]
    summary: dict[str, StrictInt | StrictFloat | StrictStr]


class SimilarPatients(Strict):
    title: Literal["Similar public-dataset patients"] = "Similar public-dataset patients"
    subtitle: Literal["from this patient's outer-training cohort", "from the training cohort"]
    status: Literal["ok", "insufficient_evidence"]
    k_effective: StrictInt = Field(ge=0, le=10)
    reference_size: StrictInt = Field(ge=0)
    patients: list[SimilarPatient]

    @model_validator(mode="after")
    def _ranked(self) -> SimilarPatients:
        if self.status == "insufficient_evidence":
            if self.patients or self.reference_size >= 3:
                raise ValueError("insufficient similarity evidence only when the reference has < 3 patients")
            return self
        if len(self.patients) != self.k_effective or self.k_effective != min(10, self.reference_size):
            raise ValueError("k_effective = min(10, reference_size) patients")
        order = [(p.distance, int(p.patient_id[4:])) for p in self.patients]
        if order != sorted(order) or [p.rank for p in self.patients] != list(range(1, len(self.patients) + 1)):
            raise ValueError("neighbours ordered by distance, ties by dataset_record_id; ranks 1..k")
        return self


class EvidenceLedger(Strict):
    band: list[Probability] = Field(min_length=2, max_length=2)
    status: Literal["ok", "insufficient_evidence"]
    n: StrictInt = Field(ge=0)
    positive_label_rate: Probability | None
    description: Literal["Empirical positive-label rate among validation patients in this probability band"] = (
        "Empirical positive-label rate among validation patients in this probability band"
    )

    @model_validator(mode="after")
    def _min_n(self) -> EvidenceLedger:
        if (self.status == "ok") != (self.n >= 20) or (self.status == "ok") != (self.positive_label_rate is not None):
            raise ValueError("a band with n < 20 shows 'insufficient evidence' and never a rate")
        return self


class AtypicalDetail(Strict):
    flag: bool
    distance_percentile: Annotated[float, Field(ge=0, le=100)] | None
    cutoff_percentile: Literal[95] = 95
    excluded_unknown_features: list[str] = Field(default_factory=list)
    message: ShortStr | None = None


class EvidencePayload(Strict):
    target: TargetId
    similar_patients: SimilarPatients
    evidence_ledger: EvidenceLedger
    atypical_profile: AtypicalDetail
    stability_interval: StabilityInterval | None = None


class SensitivityPoint(Strict):
    value: StrictInt | StrictFloat | StrictStr
    probability: Probability


class SensitivityCurve(Strict):
    feature: str
    display: str
    kind: Literal["continuous", "binary", "ordinal", "nominal"]
    current_value: StrictInt | StrictFloat | StrictStr
    current_status: Literal["provided", "imputed"]
    points: list[SensitivityPoint] = Field(min_length=2)
    swing: Finite = Field(ge=0, le=1)  # max − min probability along the curve
    class_changes: bool                # the predicted class differs somewhere within the training range


class SensitivityResponse(Strict):
    analysis_id: uuid.UUID
    request_id: uuid.UUID
    api_schema_version: str = API_SCHEMA_VERSION
    model_version: SemVer
    artifact_manifest_sha256: Sha256
    prediction_mode: Literal["final_model"]
    target: TargetId
    label: Literal["Model sensitivity, not treatment simulation"] = "Model sensitivity, not treatment simulation"
    scope: Literal["one input varied at a time across its observed training range; all other inputs held fixed"] = (
        "one input varied at a time across its observed training range; all other inputs held fixed")
    base_probability: Probability
    operating_threshold: Probability
    curves: list[SensitivityCurve]
    locked_features: list[str]
    material_unknown_inputs: list[str]  # UNKNOWN inputs whose plausible values would change the predicted class


class EvidenceResponse(EvidencePayload):
    analysis_id: uuid.UUID
    request_id: uuid.UUID
    api_schema_version: str = API_SCHEMA_VERSION
    model_version: SemVer
    artifact_manifest_sha256: Sha256
    prediction_mode: PredictionMode


# ---------------------------------------------------------------------------------------------------- full analysis
def _check_bundle(identity: _AnalysisIdentity, explanations: dict, evidence: dict) -> None:
    _check_targets_complete(explanations, "explanations")
    _check_targets_complete(evidence, "evidence")
    subtitle = (
        "from this patient's outer-training cohort" if identity.patient.prediction_mode == "oof" else "from the training cohort"
    )
    for tid in TARGET_IDS:
        exp, ev, pred = explanations[tid], evidence[tid], identity.targets[tid]
        if exp.target != tid or ev.target != tid:
            raise ValueError(f"{tid}: payload target mismatch")
        if not math.isclose(exp.calibrated_logit, pred.calibrated_logit, rel_tol=1e-9, abs_tol=1e-9):
            raise ValueError(f"{tid}: explanation must explain the displayed prediction (same calibrated logit)")
        if ev.similar_patients.subtitle != subtitle:
            raise ValueError(f"{tid}: similar-patients subtitle must match the prediction mode")
        if ev.atypical_profile.flag != identity.quality.atypical_profile.flag:
            raise ValueError(f"{tid}: atypical flag must match the analysis quality block")
        if ev.stability_interval != pred.stability_interval:
            raise ValueError(f"{tid}: stability interval must match the prediction")


class AnalyzeFullResponse(_AnalysisIdentity):
    """Persisted Analysis: all outputs from ONE BundleHandle; reopening a case renders only this."""

    request_id: uuid.UUID
    explanations: dict[TargetId, ExplanationPayload]
    evidence: dict[TargetId, EvidencePayload]

    @model_validator(mode="after")
    def _one_bundle(self) -> AnalyzeFullResponse:
        _check_bundle(self, self.explanations, self.evidence)
        return self


# ---------------------------------------------------------------------------------------------------- patients
class PatientListItem(Strict):
    patient_id: PatientId
    age: StrictInt
    sex: Literal["female", "male"]
    key_risk_factors: list[Literal["diabetes", "hypertension", "current_smoker", "family_history", "dyslipidemia", "obesity"]]


class PatientListResponse(Strict):
    patients: list[PatientListItem]
    count: StrictInt


_OOF_ID = re.compile(r"^oof:(\d+\.\d+\.\d+):(ZAS-\d{4})$")


class PatientBundle(_AnalysisIdentity):
    """GET /patients/{id}: the complete cached OOF analysis. Never contains ground truth (LIVE mode)."""

    source_oof_analysis_id: str
    patient_id: PatientId
    outer_folds: dict[TargetId, Annotated[int, Field(ge=1, le=5)]]  # per target: splits are stratified per label (D-010)
    canonical_inputs: dict[str, StrictInt | StrictFloat | StrictStr]
    explanations: dict[TargetId, ExplanationPayload]
    evidence: dict[TargetId, EvidencePayload]

    @model_validator(mode="after")
    def _oof(self) -> PatientBundle:
        m = _OOF_ID.match(self.source_oof_analysis_id)
        if not m or m.group(1) != self.model_version or m.group(2) != self.patient_id:
            raise ValueError("source_oof_analysis_id must be oof:{model_version}:{patient_id}")
        if self.patient.prediction_mode != "oof":
            raise ValueError("dataset patients are always served in OOF mode")
        _check_targets_complete(self.outer_folds, "outer_folds")
        _check_bundle(self, self.explanations, self.evidence)
        return self


class GroundTruthResponse(Strict):
    patient_id: PatientId
    labels: dict[TargetId, Literal[0, 1]]
    label_definitions: dict[TargetId, str]

    @model_validator(mode="after")
    def _all(self) -> GroundTruthResponse:
        _check_targets_complete(self.labels, "labels")
        return self


# ---------------------------------------------------------------------------------------------------- evaluation
class MetricSummary(Strict):
    mean: Finite | None
    sd: Finite | None
    n_defined: StrictInt = Field(ge=0)
    n_na: StrictInt = Field(ge=0)


class Table1Row(Strict):
    target: TargetId
    model: str
    kind: Literal["model", "always_negative", "always_positive", "prior"]
    prevalence: Probability
    metrics: dict[str, MetricSummary]


class Table2Row(Strict):
    target: TargetId
    pct_high_positive: Probability
    ppv: Probability | None
    ppv_ci: list[Probability] | None
    pct_high_negative: Probability
    npv: Probability | None
    npv_ci: list[Probability] | None
    pct_low_confidence: Probability
    accuracy_high_confidence: Probability | None
    fn_high_negative: StrictInt = Field(ge=0)
    fp_high_positive: StrictInt = Field(ge=0)


class EvaluationResponse(Strict):
    model_version: SemVer
    table1_scope: Literal["outer-fold mean ± SD"] = "outer-fold mean ± SD"
    table1: list[Table1Row]
    table2_scope: Literal["pooled OOF (prespecified repeat)"] = "pooled OOF (prespecified repeat)"
    table2: list[Table2Row]
    figures: dict[str, Any] = Field(default_factory=dict)


class GlobalImportanceFeature(Strict):
    feature: str
    display: str
    mean_abs_contribution: Annotated[float, Field(ge=0, allow_inf_nan=False)]
    points: list[list[Finite]] = Field(default_factory=list)  # [normalized feature value, contribution]


class GlobalImportanceResponse(Strict):
    target: TargetId
    scope: Literal["OOF fold-specific model attribution distribution", "final model"]
    features: list[GlobalImportanceFeature]


# ---------------------------------------------------------------------------------------------------- model center
GateStatus = Literal["PASS", "FAIL", "INSUFFICIENT_EVIDENCE"]


class ModelEntry(Strict):
    version: SemVer
    status: Literal["production", "candidate", "rejected", "retired", "replay"]
    created_at: str
    training_cases: StrictInt = Field(ge=0)
    gate_status: GateStatus | None = None
    artifact_manifest_sha256: Sha256


class LifecycleEvent(Strict):
    """One lifecycle-log entry as shown in the Model Center (the actor's name stays in the local log only)."""
    seq: StrictInt = Field(ge=0)
    timestamp: str
    # Every event the lifecycle journal writes (novarion_ml.lifecycle.log.EVENTS; a test keeps the two equal): an
    # "intent" precedes each registry change and is closed by the operation's own event or by "aborted" (audit N03).
    event: Literal["verify_outcomes", "candidate", "promote", "reject", "rollback", "publish", "intent", "aborted"]
    summary: str
    entry_hash: Sha256


class ModelsResponse(Strict):
    production_version: SemVer  # the registry pointer
    deployed_version: SemVer    # the bundle this service actually loaded (differs until a restart after promote)
    models: list[ModelEntry]
    verified_new_cases: StrictInt = Field(ge=0)
    eligible_cases: StrictInt = Field(ge=0)
    pending_cases: StrictInt = Field(ge=0)  # server-side view only; pending outcomes live in each browser
    lifecycle_log_status: Literal["intact", "broken", "empty"]
    lifecycle_events: list[LifecycleEvent]  # newest first, at most 20

    @model_validator(mode="after")
    def _one_production(self) -> ModelsResponse:
        prod = [m for m in self.models if m.status == "production"]
        if len(prod) != 1 or prod[0].version != self.production_version:
            raise ValueError("exactly one production model, matching production_version")
        return self


class GateTargetResult(Strict):
    evaluable: bool
    auc_champion: Probability | None
    auc_challenger: Probability | None
    delta_auc_ci95: list[Finite] | None
    brier_champion: Probability | None
    brier_challenger: Probability | None
    delta_brier_ci95: list[Finite] | None
    cal_slope_ci95: list[Finite] | None
    rules: dict[str, bool]


class ModelReportResponse(Strict):
    version: SemVer
    champion_version: SemVer
    gate_status: GateStatus
    evidence_label: Literal["pre-promotion validation evidence"] = "pre-promotion validation evidence"
    targets: dict[TargetId, GateTargetResult]
    gate_report_sha256: Sha256

    @model_validator(mode="after")
    def _status(self) -> ModelReportResponse:
        _check_targets_complete(self.targets, "targets")
        if self.gate_status == "INSUFFICIENT_EVIDENCE" and all(t.evaluable for t in self.targets.values()):
            raise ValueError("INSUFFICIENT_EVIDENCE requires a non-evaluable target")
        if self.gate_status != "INSUFFICIENT_EVIDENCE" and not all(t.evaluable for t in self.targets.values()):
            raise ValueError("any non-evaluable target means INSUFFICIENT_EVIDENCE")
        return self


class PromoteRequest(Strict):
    """Local mode only (plan §12B, Tier 3): a thin wrapper around the authoritative `make promote` CLI."""
    approver: str = Field(min_length=2, max_length=80)


class PromoteResponse(Strict):
    version: SemVer
    production_version: SemVer
    message: str
    restart_required: Literal[True] = True


class ReplayPoint(Strict):
    training_size: StrictInt = Field(ge=1)
    n_seeds: StrictInt = Field(ge=1)
    auc_mean: Probability
    auc_sd: Finite
    auc_min: Probability
    auc_max: Probability
    brier_mean: Probability
    brier_sd: Finite


class ReplayGate(Strict):
    seed: StrictInt = Field(ge=0)
    gate: StrictInt = Field(ge=1)
    status: GateStatus
    promoted: bool
    failed_rules: dict[TargetId, list[str]]


class ReplayResponse(Strict):
    """Historical replay study (research demonstration; never production; NOT temporal validation)."""
    title: Literal["Historical replay · random eligibility order · NOT temporal validation"]
    seeds: StrictInt = Field(ge=1)
    families: list[str]
    training_sizes: list[StrictInt]
    holdout_batch_size: StrictInt = Field(ge=1)
    learning_curve: dict[TargetId, list[ReplayPoint]]
    gate_frequencies: dict[str, dict[GateStatus, StrictInt]]
    gate_log: list[ReplayGate]
    replay_config_sha256: Sha256

    @model_validator(mode="after")
    def _complete(self) -> ReplayResponse:
        _check_targets_complete(self.learning_curve, "learning_curve")
        if any(len(points) != len(self.training_sizes) for points in self.learning_curve.values()):
            raise ValueError("one learning-curve point per training size")
        return self
