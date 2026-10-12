"""Contract mock service (plan §11A "Complete mocks frozen on Day 2").

NOT A MODEL. A deterministic toy engine that turns canonical inputs into responses that satisfy every contract
invariant (additivity, confidence regions, symmetric PPV/NPV schema, ordering, fail-closed shapes), so the 3D and
frontend tracks can build against realistic, input-dependent data before the real bundle exists.

Mock identity is unmistakable: model_version "0.0.0", bundle hashes of the string "novarion-mock-bundle", and the
API adds the response header `X-Novarion-Mock: 1`. Feature centres (median / IQR / mode) come from the real dataset
via `contracts/mock_reference.json`; weights, thresholds, comparisons and evidence numbers are synthetic.
"""

from __future__ import annotations

import hashlib
import json
import math
import uuid
from pathlib import Path
from typing import Any

import rfc8785

from novarion_ml.data.load import dataset_record_id
from novarion_ml.data.registry import CONFIG_DIR, ROOT, Feature, default_registry, load_targets

from .errors import ApiError
from .schemas import (
    CONFIDENCE_REASON_ORDER,
    TARGET_IDS,
    AnalyzeFullRequest,
    AnalyzeFullResponse,
    AtypicalDetail,
    AtypicalProfile,
    CohortComparison,
    ConfidenceQualification,
    ConfidenceThresholds,
    Contribution,
    EvaluationContext,
    EvaluationResponse,
    EvidenceLedger,
    EvidencePayload,
    EvidenceRequest,
    EvidenceResponse,
    ExplainRequest,
    ExplanationPayload,
    ExplanationResponse,
    GateTargetResult,
    GlobalImportanceFeature,
    GlobalImportanceResponse,
    GroundTruthResponse,
    GroupContribution,
    GroupStat,
    HealthReady,
    Imputation,
    LifecycleEvent,
    MetaResponse,
    MetricSummary,
    ModelEntry,
    ModelReportResponse,
    ModelsResponse,
    PatientBundle,
    PatientContext,
    PatientListItem,
    PatientListResponse,
    PredictionQuality,
    PredictionResponse,
    PredictRequest,
    QualityNotice,
    ReplayGate,
    ReplayPoint,
    ReplayResponse,
    SensitivityRequest,
    SensitivityResponse,
    SimilarPatient,
    SimilarPatients,
    StabilityInterval,
    StrengthCutpoints,
    Table1Row,
    Table2Row,
    TargetPrediction,
    TargetSpec,
    Thresholds,
    ValidateRequest,
    ValidateResponse,
)
from .service import (
    InferenceService,
    build_validate_response,
    canonical_or_block,
    check_pinned,
    feature_specs,
    leakage_denylist,
)
from .settings import APP_VERSION, Settings

CONTRACTS_DIR = ROOT / "contracts"
MOCK_MODEL_VERSION = "0.0.0"
MOCK_PREPROCESSING_VERSION = "0.0.0"
MOCK_BUNDLE_SHA256 = hashlib.sha256(b"novarion-mock-bundle").hexdigest()
MOCK_TRAINING_SHA256 = hashlib.sha256(b"novarion-mock-bundle:training").hexdigest()
MOCK_REFCTX = {t: hashlib.sha256(f"novarion-mock-bundle:refctx:{t}".encode()).hexdigest() for t in TARGET_IDS}
MOCK_REFCTX_SHA256 = hashlib.sha256(rfc8785.dumps(MOCK_REFCTX)).hexdigest()
UUID_NAMESPACE = uuid.UUID("6f1d3c1e-6c55-4c5e-9a43-6e6f76617269")

# Synthetic operating points: (t_op, t_neg | None, t_pos | None). LCX has no qualified positive region on purpose,
# so the frontend exercises the "no_qualified_region" LOW reason.
MOCK_THRESHOLDS = {"cad": (0.60, 0.30, 0.85), "lad": (0.50, 0.25, 0.80), "lcx": (0.45, 0.20, None),
                   "rca": (0.45, 0.20, 0.75)}
MOCK_BASE_LOGIT = {"cad": 0.85, "lad": 0.30, "lcx": -0.40, "rca": -0.45}
MOCK_STRENGTH = StrengthCutpoints(q1=0.04, q2=0.15)
WEIGHT_SCALE = 0.45


def _u(*parts: object) -> float:
    """Deterministic pseudo-random number in [0, 1) from the given parts."""
    digest = hashlib.sha256(":".join(str(p) for p in parts).encode()).hexdigest()
    return int(digest[:13], 16) / 16**13


def _sigmoid(x: float) -> float:
    return 1 / (1 + math.exp(-x))


def _clip(x: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return min(hi, max(lo, x))


class MockService(InferenceService):
    is_mock = True

    def __init__(self, settings: Settings, contracts_dir: Path = CONTRACTS_DIR):
        self.settings = settings
        self.registry = default_registry()
        self.by_id = self.registry.by_id()
        self.targets_cfg = load_targets()
        self.target_spec = {t["id"]: t for t in self.targets_cfg["targets"]}
        self.reference = json.loads((contracts_dir / "mock_reference.json").read_text(encoding="utf-8"))
        patients = json.loads((contracts_dir / "mock_dataset_patients.json").read_text(encoding="utf-8"))
        self.dataset = {p["patient_id"]: p for p in patients["patients"]}
        self.expected_hashes = {p["dataset_record_id"]: p["expected_input_sha256"] for p in self.dataset.values()}
        anatomy = json.loads((CONFIG_DIR / "anatomy_manifest.json").read_text(encoding="utf-8"))
        self.anatomy_version = anatomy["manifest"]["anatomy_version"]
        self.anatomy_asset_sha256 = anatomy["anatomy_asset_sha256"]
        self.anatomy_map = json.loads((CONFIG_DIR / "anatomy_map.json").read_text(encoding="utf-8"))

    # -------------------------------------------------------------------------------------------- toy engine
    def _z(self, feature: Feature, value: Any) -> float:
        ref = self.reference["features"][feature.id]
        if feature.kind == "continuous":
            return _clip((value - ref["median"]) / (ref["iqr"] or 1.0), -3.0, 3.0)
        if feature.kind == "binary":
            return value - ref["mean"]
        index = feature.categories.index(value)
        if feature.kind == "ordinal":
            return (index - feature.categories.index(ref["mode"])) / max(1, len(feature.categories) - 1) * 2
        return 0.0 if value == ref["mode"] else 1.0

    def _impute(self, feature: Feature) -> Any:
        ref = self.reference["features"][feature.id]
        if feature.kind == "continuous":
            return ref["median"]
        return ref["mode"]

    def _display_value(self, feature: Feature, value: Any) -> str:
        if feature.kind == "binary":
            if feature.categories:
                return feature.categories[value].capitalize()
            return "Yes" if value == 1 else "No"
        if feature.kind == "continuous":
            precision = feature.display_precision or 0
            unit = feature.canonical_unit or ""
            sep = "" if unit == "%" else " "
            return f"{value:.{precision}f}{sep}{unit}".strip()
        return str(value).capitalize()

    def _contributions(self, target: str, canonical: dict[str, Any], mode: str) -> list[Contribution]:
        unknown = self.registry.unknown_token
        rows = []
        for feature in self.registry.features:
            if feature.input_mode == "constant":  # zero-variance: dropped by the real pipeline, never explained
                continue
            raw = canonical[feature.id]
            imputed = raw == unknown
            value = self._impute(feature) if imputed else raw
            weight = (2 * _u("w", target, feature.id) - 1) * WEIGHT_SCALE
            contribution = round(weight * self._z(feature, value), 9) + 0.0
            status = "imputed" if imputed else "computed" if feature.input_mode == "computed" else "provided"
            display_value = self._display_value(feature, value)
            if imputed:
                display_value = f"Unknown (imputed {display_value})"
            rows.append({
                "feature": feature.id, "display": feature.display, "value": value, "display_value": display_value,
                "contribution": contribution, "group": feature.group, "value_status": status,
                "imputation": Imputation(
                    method="median" if feature.kind == "continuous" else "mode", value=value,
                    fit_scope="fold_outer_training" if mode == "oof" else "full_cohort",
                ) if imputed else None,
                "cohort_comparison": None if imputed else self._comparison(target, feature, value),
            })
        rows.sort(key=lambda r: (-abs(r["contribution"]), r["feature"]))
        mass = math.fsum(abs(r["contribution"]) for r in rows)
        out = []
        for r in rows:
            c, mag = r["contribution"], abs(r["contribution"])
            out.append(Contribution(
                **r,
                direction="up" if c > 0 else "down" if c < 0 else "neutral",
                strength="slight" if mag <= MOCK_STRENGTH.q1 else "moderate" if mag <= MOCK_STRENGTH.q2 else "strong",
                relative_share=None if mass == 0 else mag / mass,
            ))
        return out

    def _comparison(self, target: str, feature: Feature, value: Any) -> CohortComparison:
        counts = self.reference["target_counts"][target]
        if feature.kind == "continuous":
            kind, key = "percentile", "percentile"
            base = 50 + 15 * self._z(feature, value)
            stats = {"negative": _clip(base + 8, 1, 99), "positive": _clip(base - 8, 1, 99)}
        else:
            kind = "binary_prevalence" if feature.kind == "binary" else "category_frequency"
            key = "rate"
            centre = _u("rate", feature.id, value)
            stats = {"negative": _clip(centre - 0.08), "positive": _clip(centre + 0.08)}
        sides = {}
        for side in ("negative", "positive"):
            n = counts[side]
            if n >= self.targets_cfg["cohort_comparison_min_n"]:
                sides[side] = GroupStat(n=n, status="ok", **{key: round(stats[side], 4)})
            else:
                sides[side] = GroupStat(n=n, status="insufficient_evidence")
        return CohortComparison(type=kind, value=value, **sides)

    def _prediction(self, target: str, logit: float, unknown_inputs: bool, mode: str, record: int | None
                    ) -> TargetPrediction:
        t_op, t_neg, t_pos = MOCK_THRESHOLDS[target]
        p = _sigmoid(logit)
        if t_pos is not None and p >= t_pos:
            region = "high_positive"
        elif t_neg is not None and p < t_neg:
            region = "high_negative"
        else:
            region = "low_confidence"
        reasons = []
        if unknown_inputs:
            reasons.append("unknown_input")
        if region == "low_confidence":
            side_missing = t_pos is None if p >= t_op else t_neg is None
            reasons.append("no_qualified_region" if side_missing else "gray_zone")
        reasons = sorted(set(reasons), key=CONFIDENCE_REASON_ORDER.index)
        qualification = evaluation = None
        if not reasons:
            metric = "ppv" if region == "high_positive" else "npv"
            goal = self.targets_cfg["confidence"][f"target_{metric}"]
            jitter = _u("q", target, metric)
            n = 30 + int(jitter * 60)
            qualification = ConfidenceQualification(
                metric=metric, target=goal, lower_bound=round(goal + (1 - goal) * 0.3 * jitter, 4), n=n,
            )
            value = round(goal + (1 - goal) * (0.4 + 0.4 * jitter), 4)
            evaluation = EvaluationContext(
                metric=metric, value=value, ci=[round(value - 0.06, 4), round(min(1.0, value + 0.04), 4)], n=n,
            )
        stability = None
        if mode == "oof":
            spread = 0.03 + 0.06 * _u("stab", target, record)
            stability = StabilityInterval(p10=_clip(p - spread), p90=_clip(p + spread), n_valid=100)
        return TargetPrediction(
            label=self.target_spec[target]["display"], anatomy_key=self.target_spec[target]["anatomy_key"],
            predicted_class="positive" if p >= t_op else "negative", probability=p, calibrated_logit=logit,
            operating_threshold=t_op,
            model_confidence="high" if not reasons else "low",
            model_confidence_thresholds=ConfidenceThresholds(negative_below=t_neg, positive_at_or_above=t_pos),
            model_confidence_region=region, model_confidence_reasons=reasons,
            confidence_qualification=qualification, evaluation_context=evaluation, stability_interval=stability,
        )

    def _evidence(self, target: str, p: float, input_sha: str, mode: str, stability, exclude: int | None
                  ) -> EvidencePayload:
        reference_size = 242 if mode == "oof" else 303
        picks: dict[int, float] = {}
        i = 0
        while len(picks) < 10:
            record = int(_u("nn", target, input_sha, i) * 303)
            if record == exclude:  # an OOF reference never contains the patient itself
                i += 1
                continue
            picks.setdefault(record, round(0.05 + 0.45 * _u("d", target, input_sha, i), 4))
            i += 1
        ordered = sorted(picks.items(), key=lambda kv: (kv[1], kv[0]))
        similar = [
            SimilarPatient(
                patient_id=f"ZAS-{record + 1:04d}", rank=rank, distance=distance,
                labels={t: int(_u("lab", t, record) < 0.5) for t in TARGET_IDS},
                summary={"age": 40 + int(_u("age", record) * 40)},
            )
            for rank, (record, distance) in enumerate(ordered, start=1)
        ]
        bands = self.targets_cfg["evidence_bands"]
        band = next(b for b in bands if b[0] <= p < b[1] or (b[1] == 1.0 and p == 1.0))
        n = 20 + int(_u("ledger", target, band[0]) * 60)
        return EvidencePayload(
            target=target,
            similar_patients=SimilarPatients(
                subtitle="from this patient's outer-training cohort" if mode == "oof" else "from the training cohort",
                status="ok", k_effective=10, reference_size=reference_size, patients=similar,
            ),
            evidence_ledger=EvidenceLedger(
                band=band, status="ok", n=n, positive_label_rate=round(_clip(sum(band) / 2 + 0.05), 4),
            ),
            atypical_profile=AtypicalDetail(flag=False, distance_percentile=round(90 * _u("atyp", input_sha), 1)),
            stability_interval=stability,
        )

    def _analysis(self, canonical: dict[str, Any], input_sha: str, mode: str, record: int | None = None):
        unknown = self.registry.unknown_token
        unknown_inputs = sorted(k for k, v in canonical.items() if v == unknown)
        targets, explanations, evidence = {}, {}, {}
        for t in TARGET_IDS:
            contributions = self._contributions(t, canonical, mode)
            logit = MOCK_BASE_LOGIT[t] + math.fsum(c.contribution for c in contributions)
            targets[t] = self._prediction(t, logit, bool(unknown_inputs), mode, record)
            groups: dict[str, float] = {}
            for c in contributions:
                groups[c.group] = groups.get(c.group, 0.0) + c.contribution
            explanations[t] = ExplanationPayload(
                target=t, base_calibrated_logit=MOCK_BASE_LOGIT[t], calibrated_logit=logit,
                contributions=contributions, strength_cutpoints=MOCK_STRENGTH,
                groups={
                    g: GroupContribution(
                        contribution=s,
                        strength="slight" if abs(s) <= MOCK_STRENGTH.q1 else "moderate" if abs(s) <= MOCK_STRENGTH.q2
                        else "strong",
                    ) for g, s in groups.items()
                },
            )
            evidence[t] = self._evidence(
                t, targets[t].probability, input_sha, mode, targets[t].stability_interval, record,
            )
        quality = PredictionQuality(
            atypical_profile=AtypicalProfile(flag=False, distance_percentile=round(90 * _u("atyp", input_sha), 1)),
            unknown_inputs=unknown_inputs,
        )
        return targets, explanations, evidence, quality

    def _identity(self, input_sha: str, analysis_id: uuid.UUID, mode: str) -> dict[str, Any]:
        return {
            "analysis_id": analysis_id, "app_version": APP_VERSION, "model_version": MOCK_MODEL_VERSION,
            "preprocessing_version": MOCK_PREPROCESSING_VERSION, "anatomy_version": self.anatomy_version,
            "anatomy_asset_sha256": self.anatomy_asset_sha256, "input_sha256": input_sha,
            "training_data_sha256": MOCK_TRAINING_SHA256, "artifact_manifest_sha256": MOCK_BUNDLE_SHA256,
            "reference_context_sha256": MOCK_REFCTX_SHA256, "target_status": {t: "complete" for t in TARGET_IDS},
            "patient": PatientContext(prediction_mode=mode),
        }

    def _dataset_notices(self, record: int | None, input_sha: str) -> list[QualityNotice]:
        if input_sha in self.expected_hashes.values():
            return [QualityNotice(code="exact_training_match",
                                  message="This exact profile is a training record of the model.")]
        if record is not None:
            return [QualityNotice(code="derived_from_training_record",
                                  message="Edited from a dataset record that the final model was trained on.")]
        return []

    # -------------------------------------------------------------------------------------------- endpoints
    def ready(self) -> HealthReady:
        return HealthReady(ready=True, model_version=MOCK_MODEL_VERSION, artifact_manifest_sha256=MOCK_BUNDLE_SHA256)

    def meta(self) -> MetaResponse:
        features = feature_specs()
        return MetaResponse(
            app_version=APP_VERSION, model_version=MOCK_MODEL_VERSION, preprocessing_version=MOCK_PREPROCESSING_VERSION,
            run_mode=self.settings.run_mode, promote_available=self.settings.run_mode == "local" and bool(self.settings.admin_token), unknown_token=self.registry.unknown_token,
            targets=[
                TargetSpec(id=t["id"], display=t["display"], anatomy_key=t["anatomy_key"],
                           label_definition=t["label_definition"])
                for t in self.targets_cfg["targets"]
            ],
            features=features,
            thresholds={t: Thresholds(t_op=a, t_neg=b, t_pos=c) for t, (a, b, c) in MOCK_THRESHOLDS.items()},
            anatomy_version=self.anatomy_version, anatomy_asset_sha256=self.anatomy_asset_sha256,
            anatomy_map=self.anatomy_map, evidence_bands=self.targets_cfg["evidence_bands"], leakage_denylist=leakage_denylist(),
        )

    def validate(self, req: ValidateRequest) -> ValidateResponse:
        return build_validate_response(req, self.expected_hashes.get)

    def predict(self, req: PredictRequest, analysis_id: uuid.UUID | None = None) -> PredictionResponse:
        result = canonical_or_block(req)
        targets, _, _, quality = self._analysis(result.canonical, result.input_sha256, "final_model")
        quality = quality.model_copy(update={"notices": self._dataset_notices(None, result.input_sha256)})
        return PredictionResponse(
            **self._identity(result.input_sha256, analysis_id or uuid.uuid4(), "final_model"),
            request_id=req.request_id, input_revision=req.input_revision, quality=quality, targets=targets,
        )

    def analyze_full(self, req: AnalyzeFullRequest, analysis_id: uuid.UUID | None = None) -> AnalyzeFullResponse:
        result = canonical_or_block(req)
        targets, explanations, evidence, quality = self._analysis(result.canonical, result.input_sha256, "final_model")
        notices = self._dataset_notices(req.dataset_record_id, result.input_sha256)
        return AnalyzeFullResponse(
            **self._identity(result.input_sha256, analysis_id or uuid.uuid4(), "final_model"),
            request_id=req.request_id, quality=quality.model_copy(update={"notices": notices}), targets=targets,
            explanations=explanations, evidence=evidence,
        )

    def _pinned_meta(self, req) -> dict[str, Any]:
        return {"analysis_id": req.analysis_id, "request_id": req.request_id, "model_version": MOCK_MODEL_VERSION,
                "artifact_manifest_sha256": MOCK_BUNDLE_SHA256, "prediction_mode": "final_model"}

    def explain(self, req: ExplainRequest) -> ExplanationResponse:
        result = check_pinned(req, MOCK_MODEL_VERSION, MOCK_BUNDLE_SHA256)
        _, explanations, _, _ = self._analysis(result.canonical, result.input_sha256, "final_model")
        return ExplanationResponse(**explanations[req.target].model_dump(), **self._pinned_meta(req))

    def sensitivity(self, req: SensitivityRequest) -> SensitivityResponse:
        """Toy curves for the contract mock (not a model): five mutable continuous features, monotone in the value."""
        result = check_pinned(req, MOCK_MODEL_VERSION, MOCK_BUNDLE_SHA256)
        targets, _, _, _ = self._analysis(result.canonical, result.input_sha256, "final_model")
        base = targets[req.target].probability
        registry = default_registry()
        features = [f for f in registry.features if f.input_mode == "entered" and not f.immutable_in_whatif
                    and f.kind == "continuous" and f.hard_valid_range][:5]
        curves = []
        for k, f in enumerate(features):
            lo, hi = f.hard_valid_range
            step = 0.04 * (k + 1)
            pts = [{"value": round(lo + (hi - lo) * i / 4, 1), "probability": min(1.0, max(0.0, base + step * (i - 2)))}
                   for i in range(5)]
            ps = [p["probability"] for p in pts]
            current = result.canonical[f.id]
            curves.append({"feature": f.id, "display": f.display, "kind": "continuous",
                           "current_value": pts[2]["value"] if current == registry.unknown_token else current,
                           "current_status": "imputed" if current == registry.unknown_token else "provided",
                           "points": pts, "swing": max(ps) - min(ps), "class_changes": min(ps) < 0.5 <= max(ps)})
        return SensitivityResponse(**self._pinned_meta(req), target=req.target, base_probability=base,
                                   operating_threshold=0.5, curves=sorted(curves, key=lambda c: -c["swing"]),
                                   locked_features=sorted(f.id for f in registry.features if f.immutable_in_whatif),
                                   material_unknown_inputs=[])

    def evidence(self, req: EvidenceRequest) -> EvidenceResponse:
        result = check_pinned(req, MOCK_MODEL_VERSION, MOCK_BUNDLE_SHA256)
        _, _, evidence, _ = self._analysis(result.canonical, result.input_sha256, "final_model")
        return EvidenceResponse(**evidence[req.target].model_dump(), **self._pinned_meta(req))

    def _dataset_patient(self, patient_id: str) -> dict[str, Any]:
        try:
            dataset_record_id(patient_id)
        except ValueError as exc:
            raise ApiError("NOT_FOUND", "Unknown patient.") from exc
        if patient_id not in self.dataset:
            raise ApiError("NOT_FOUND", "Unknown patient.")
        return self.dataset[patient_id]

    def patients(self) -> PatientListResponse:
        items = []
        for pid, p in sorted(self.dataset.items()):
            x = p["canonical_inputs"]
            factors = ["diabetes", "hypertension", "current_smoker", "family_history", "dyslipidemia", "obesity"]
            items.append(PatientListItem(
                patient_id=pid, age=x["age"], sex="male" if x["sex"] == 1 else "female",
                key_risk_factors=[f for f in factors if x[f] == 1],
            ))
        return PatientListResponse(patients=items, count=len(items))

    def patient(self, patient_id: str) -> PatientBundle:
        p = self._dataset_patient(patient_id)
        record = p["dataset_record_id"]
        source_id = f"oof:{MOCK_MODEL_VERSION}:{patient_id}"
        targets, explanations, evidence, quality = self._analysis(
            p["canonical_inputs"], p["expected_input_sha256"], "oof", record,
        )
        return PatientBundle(
            **self._identity(p["expected_input_sha256"], uuid.uuid5(UUID_NAMESPACE, source_id), "oof"),
            source_oof_analysis_id=source_id, patient_id=patient_id, outer_folds={t: (record + i) % 5 + 1 for i, t in enumerate(TARGET_IDS)},
            canonical_inputs=p["canonical_inputs"], quality=quality, targets=targets,
            explanations=explanations, evidence=evidence,
        )

    def ground_truth(self, patient_id: str) -> GroundTruthResponse:
        p = self._dataset_patient(patient_id)
        return GroundTruthResponse(
            patient_id=patient_id, labels=p["labels"],
            label_definitions={t["id"]: t["label_definition"] for t in self.targets_cfg["targets"]},
        )

    def evaluation(self) -> EvaluationResponse:
        table1, table2 = [], []
        for t in TARGET_IDS:
            prevalence = self.reference["target_counts"][t]["prevalence"]
            for model, kind in (("mock_model", "model"), ("always_negative", "always_negative"),
                                ("always_positive", "always_positive"), ("prior", "prior")):
                metrics = {}
                for metric in ("roc_auc", "accuracy", "precision", "recall", "f1", "brier"):
                    defined = not (kind == "always_negative" and metric in ("precision", "f1"))
                    mean = round(0.5 + 0.4 * _u("m", t, model, metric), 4) if defined else None
                    metrics[metric] = MetricSummary(mean=mean, sd=0.04 if defined else None,
                                                    n_defined=5 if defined else 0, n_na=0 if defined else 5)
                table1.append(Table1Row(target=t, model=model, kind=kind, prevalence=prevalence, metrics=metrics))
            hp, hn = round(0.2 + 0.2 * _u("hp", t), 4), round(0.1 + 0.2 * _u("hn", t), 4)
            table2.append(Table2Row(
                target=t, pct_high_positive=hp, ppv=0.93, ppv_ci=[0.88, 0.97], pct_high_negative=hn, npv=0.95,
                npv_ci=[0.89, 0.99], pct_low_confidence=round(1 - hp - hn, 4), accuracy_high_confidence=0.94,
                fn_high_negative=2, fp_high_positive=3,
            ))
        return EvaluationResponse(model_version=MOCK_MODEL_VERSION, table1=table1, table2=table2)

    def global_importance(self, target: str) -> GlobalImportanceResponse:
        if target not in TARGET_IDS:
            raise ApiError("NOT_FOUND", "Unknown target.")
        features = sorted(
            (
                GlobalImportanceFeature(
                    feature=f.id, display=f.display,
                    mean_abs_contribution=round(abs((2 * _u("w", target, f.id) - 1) * WEIGHT_SCALE) * 0.6, 6),
                )
                for f in self.registry.features
            ),
            key=lambda g: (-g.mean_abs_contribution, g.feature),
        )
        return GlobalImportanceResponse(target=target, scope="OOF fold-specific model attribution distribution",
                                        features=features)

    def models(self) -> ModelsResponse:
        return ModelsResponse(
            production_version=MOCK_MODEL_VERSION,
            models=[
                ModelEntry(version=MOCK_MODEL_VERSION, status="production", created_at="2026-10-04T00:00:00Z",
                           training_cases=303, artifact_manifest_sha256=MOCK_BUNDLE_SHA256),
                ModelEntry(version="0.1.0", status="rejected", created_at="2026-10-04T00:00:00Z", training_cases=353,
                           gate_status="FAIL",
                           artifact_manifest_sha256=hashlib.sha256(b"novarion-mock-bundle:0.1.0").hexdigest()),
            ],
            verified_new_cases=50, eligible_cases=50, pending_cases=0, deployed_version=MOCK_MODEL_VERSION,
            lifecycle_log_status="intact", lifecycle_events=[LifecycleEvent(
                seq=0, timestamp="2026-10-04T00:00:00Z", event="reject",
                summary="Candidate v0.1.0 rejected by a human reviewer (gate FAIL) [mock]",
                entry_hash=hashlib.sha256(b"novarion-mock-log:0").hexdigest())],
        )

    def replay(self) -> ReplayResponse:
        """Toy replay study for the contract mock (not a result)."""
        def point(size: int, auc: float) -> ReplayPoint:
            return ReplayPoint(training_size=size, n_seeds=2, auc_mean=auc, auc_sd=0.03, auc_min=auc - 0.04,
                               auc_max=auc + 0.04, brier_mean=0.18, brier_sd=0.02)

        return ReplayResponse(
            title="Historical replay · random eligibility order · NOT temporal validation", seeds=2,
            families=["lr"], training_sizes=[153, 203, 253], holdout_batch_size=50,
            learning_curve={t: [point(153, 0.70), point(203, 0.72), point(253, 0.73)] for t in TARGET_IDS},
            gate_frequencies={"gate 1": {"PASS": 0, "FAIL": 2, "INSUFFICIENT_EVIDENCE": 0},
                              "gate 2": {"PASS": 1, "FAIL": 1, "INSUFFICIENT_EVIDENCE": 0}},
            gate_log=[ReplayGate(seed=s, gate=g, status="PASS" if (s, g) == (0, 2) else "FAIL",
                                 promoted=(s, g) == (0, 2), failed_rules={} if (s, g) == (0, 2) else {"lcx": ["improved"]})
                      for s in range(2) for g in (1, 2)],
            replay_config_sha256=hashlib.sha256(b"novarion-mock-replay").hexdigest(),
        )

    def model_report(self, version: str) -> ModelReportResponse:
        if version != "0.1.0":
            raise ApiError("NOT_FOUND", "No gate report for this version.")
        rules = ["delta_auc_noninferior", "delta_brier", "delta_brier_ci", "calibration_slope", "calibration_in_large"]
        targets = {}
        for t in TARGET_IDS:
            failed = t == "lcx"
            targets[t] = GateTargetResult(
                evaluable=True, auc_champion=0.80, auc_challenger=0.77 if failed else 0.81,
                delta_auc_ci95=[-0.09, 0.02] if failed else [-0.02, 0.04], brier_champion=0.18,
                brier_challenger=0.19 if failed else 0.17, delta_brier_ci95=[-0.01, 0.03] if failed else [-0.03, 0.01],
                cal_slope_ci95=[0.7, 1.3], rules={r: not (failed and r == "delta_auc_noninferior") for r in rules},
            )
        return ModelReportResponse(
            version=version, champion_version=MOCK_MODEL_VERSION, gate_status="FAIL", targets=targets,
            gate_report_sha256=hashlib.sha256(b"novarion-mock-bundle:gate:0.1.0").hexdigest(),
        )

