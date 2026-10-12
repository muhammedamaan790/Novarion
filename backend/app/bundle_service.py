"""Real inference service behind the frozen contract (plan §10, §11, §11A "Backend runtime").

Startup integrity: the registry pointer → bundle manifest (non-circular hash) → SHA-256 of every listed artifact →
demo-bundle index. Any mismatch or missing file → the service is not constructed and the API fails closed
(`/health/ready` false). Production loads ONLY the 4 final target bundles; dataset (OOF) patients are served from the
precomputed per-patient files, never by loading fold models.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from pathlib import Path
from typing import Any

import joblib
import rfc8785

from novarion_ml.calibrate.platt import Platt
from novarion_ml.data.load import dataset_record_id
from novarion_ml.data.registry import CONFIG_DIR, ROOT, default_registry, load_targets
from novarion_ml.inference.engine import Engine, TargetArtifact
from novarion_ml.thresholds.layers import Qualification, Thresholds

from .errors import ApiError
from .schemas import (
    TARGET_IDS,
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
    PredictionResponse,
    PredictRequest,
    QualityItem,
    ReplayResponse,
    SensitivityRequest,
    SensitivityResponse,
    TargetSpec,
    ValidateRequest,
    ValidateResponse,
)
from .schemas import (
    Thresholds as ThresholdsSchema,
)
from .service import (
    InferenceService,
    build_validate_response,
    canonical_or_block,
    check_pinned,
    feature_specs,
    gate_report,
    leakage_denylist,
    lifecycle_view,
    replay_study,
)
from .settings import APP_VERSION, Settings

REGISTRY_FILE = ROOT / "registry" / "models.json"


class IntegrityError(RuntimeError):
    pass


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _matches_config(path: Path, expected: str) -> bool:
    """Allow Git's LF/CRLF conversion only; any other serving-config change invalidates the bundle."""
    raw = path.read_bytes()
    lf = raw.replace(b"\r\n", b"\n")
    return expected in {hashlib.sha256(data).hexdigest() for data in (raw, lf, lf.replace(b"\n", b"\r\n"))}


def _thresholds(d: dict[str, Any]) -> Thresholds:
    def q(x):
        return None if x is None else Qualification(**x)

    return Thresholds(d["t_op"], d["t_neg"], d["t_pos"], q(d["qualification_negative"]), q(d["qualification_positive"]))


def verify_bundle(bundle_dir: Path) -> tuple[dict[str, Any], str, dict[str, Any]]:
    """Return (manifest, artifact_manifest_sha256, demo index) or raise IntegrityError. Never loads a partial bundle."""
    doc = json.loads((bundle_dir / "manifest.json").read_text(encoding="utf-8"))
    manifest, claimed = doc["manifest"], doc["artifact_manifest_sha256"]
    if hashlib.sha256(rfc8785.dumps(manifest)).hexdigest() != claimed:
        raise IntegrityError("manifest hash mismatch")
    for rel, expected in manifest["files"].items():
        path = bundle_dir / rel
        if not path.is_file():
            raise IntegrityError(f"missing artifact {rel}")
        if _sha(path) != expected:
            raise IntegrityError(f"artifact hash mismatch: {rel}")
    for name, key in (
        ("anatomy_map.json", "anatomy_map_sha256"),
        ("feature_registry.yaml", "feature_schema_sha256"),
        ("targets.yaml", "target_schema_sha256"),
    ):
        if not _matches_config(CONFIG_DIR / name, manifest[key]):
            raise IntegrityError(f"{name} differs from the serving configuration this bundle was built with")
    index_doc = json.loads((bundle_dir / "demo_bundle" / "index.json").read_text(encoding="utf-8"))
    index = index_doc["index"]
    if hashlib.sha256(rfc8785.dumps(index)).hexdigest() != index_doc["demo_bundle_sha256"]:
        raise IntegrityError("demo bundle index hash mismatch")
    if index["artifact_manifest_sha256"] != claimed:
        raise IntegrityError("demo bundle belongs to a different model bundle")
    for rel, expected in index["files"].items():
        path = bundle_dir / "demo_bundle" / rel
        if not path.is_file() or _sha(path) != expected:
            raise IntegrityError(f"demo bundle file missing or modified: {rel}")
    return manifest, claimed, index


def production_bundle_dir() -> Path:
    registry = json.loads(REGISTRY_FILE.read_text(encoding="utf-8"))
    entry = next(m for m in registry["models"] if m["version"] == registry["production_version"])
    directory = ROOT / entry["path"]
    doc = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    if doc["artifact_manifest_sha256"] != entry["artifact_manifest_sha256"]:
        raise IntegrityError("production registry points to a different artifact manifest")
    if doc["manifest"]["model_version"] != entry["version"]:
        raise IntegrityError("production registry version differs from the bundle version")
    return directory


class BundleService(InferenceService):
    def __init__(self, settings: Settings, bundle_dir: Path | None = None):
        self.settings = settings
        self.dir = bundle_dir or production_bundle_dir()
        self.manifest, self.artifact_sha, self.index = verify_bundle(self.dir)
        self.registry = default_registry()
        self.targets_cfg = load_targets()
        spec = {t["id"]: t for t in self.targets_cfg["targets"]}
        metrics = json.loads((self.dir / "evaluation" / "metrics.json").read_text(encoding="utf-8"))
        strength = json.loads((self.dir / "strength_cutpoints.json").read_text(encoding="utf-8"))
        self.metrics = metrics
        self.importance = json.loads((self.dir / "global_importance.json").read_text(encoding="utf-8"))
        arts = {}
        for t in TARGET_IDS:
            d = self.dir / "targets" / t / "final"
            cal = json.loads((d / "calibrator.json").read_text(encoding="utf-8"))
            arts[t] = TargetArtifact(
                t, spec[t]["display"], spec[t]["anatomy_key"], joblib.load(d / "model.joblib"),
                Platt(cal["a"], cal["b"]), _thresholds(json.loads((d / "thresholds.json").read_text(encoding="utf-8"))),
                joblib.load(d / "reference_context.joblib"), {"q1": strength[t]["q1"], "q2": strength[t]["q2"]},
                metrics["targets"][t]["table2"],
            )
        self.engine = Engine(arts, mode="final_model", registry=self.registry)
        refs = {t: self.manifest["reference_context_sha256"][f"{t}:final"] for t in TARGET_IDS}
        self.final_refctx_sha = hashlib.sha256(rfc8785.dumps(refs)).hexdigest()
        self.patients_by_id = {p["patient_id"]: p for p in self.index["patients"]}
        self.expected_by_record = {p["dataset_record_id"]: p["expected_input_sha256"] for p in self.index["patients"]}
        self.training_hashes = set(self.expected_by_record.values())
        self.anatomy_map = json.loads((CONFIG_DIR / "anatomy_map.json").read_text(encoding="utf-8"))

    @property
    def model_version(self) -> str:
        return self.manifest["model_version"]

    # -------------------------------------------------------------------------------------------- helpers
    def _identity(self, input_sha: str, analysis_id: uuid.UUID) -> dict[str, Any]:
        m = self.manifest
        return {
            "analysis_id": analysis_id, "app_version": APP_VERSION, "model_version": m["model_version"],
            "preprocessing_version": m["preprocessing_version"], "anatomy_version": m["anatomy_version"],
            "anatomy_asset_sha256": m["anatomy_asset_sha256"], "input_sha256": input_sha,
            "training_data_sha256": m["training_data_sha256"], "artifact_manifest_sha256": self.artifact_sha,
            "reference_context_sha256": self.final_refctx_sha, "target_status": {t: "complete" for t in TARGET_IDS},
            "patient": {"prediction_mode": "final_model"},
        }

    def _notices(self, input_sha: str, record: int | None) -> list[dict[str, str]]:
        if input_sha in self.training_hashes:
            return [{"code": "exact_training_match",
                     "message": "This exact profile is a training record: the production model has seen it."}]
        if record is not None:
            return [{"code": "derived_from_training_record",
                     "message": "Derived from a training record: the production model has seen the original "
                                "profile, so this prediction may be optimistic."}]
        return []

    def _pinned(self, req) -> dict[str, Any]:
        return {"analysis_id": req.analysis_id, "request_id": req.request_id, "model_version": self.model_version,
                "artifact_manifest_sha256": self.artifact_sha, "prediction_mode": "final_model"}

    def _patient_file(self, patient_id: str) -> dict[str, Any]:
        try:
            dataset_record_id(patient_id)
        except ValueError as exc:
            raise ApiError("NOT_FOUND", "Unknown patient.") from exc
        if patient_id not in self.patients_by_id:
            raise ApiError("NOT_FOUND", "Unknown patient.")
        return json.loads((self.dir / "demo_bundle" / "patients" / f"{patient_id}.json").read_text(encoding="utf-8"))

    # -------------------------------------------------------------------------------------------- endpoints
    def ready(self) -> HealthReady:
        return HealthReady(ready=True, model_version=self.model_version, artifact_manifest_sha256=self.artifact_sha)

    def meta(self) -> MetaResponse:
        features = feature_specs()
        thresholds = {t: ThresholdsSchema(t_op=a.thresholds.t_op, t_neg=a.thresholds.t_neg, t_pos=a.thresholds.t_pos)
                      for t, a in self.engine.targets.items()}
        return MetaResponse(
            app_version=APP_VERSION, model_version=self.model_version,
            preprocessing_version=self.manifest["preprocessing_version"], run_mode=self.settings.run_mode,
            promote_available=self.settings.run_mode == "local" and bool(self.settings.admin_token), unknown_token=self.registry.unknown_token,
            targets=[TargetSpec(id=t["id"], display=t["display"], anatomy_key=t["anatomy_key"],
                                label_definition=t["label_definition"]) for t in self.targets_cfg["targets"]],
            features=features, thresholds=thresholds, anatomy_version=self.manifest["anatomy_version"],
            anatomy_asset_sha256=self.manifest["anatomy_asset_sha256"], anatomy_map=self.anatomy_map,
            evidence_bands=self.targets_cfg["evidence_bands"], leakage_denylist=leakage_denylist(),
        )

    def validate(self, req: ValidateRequest) -> ValidateResponse:
        response = build_validate_response(req, self.expected_by_record.get)
        if not response.ready or response.canonical_inputs is None:
            return response
        observed = next(iter(self.engine.targets.values())).reference
        extra = []
        for fid in observed.outside_observed(response.canonical_inputs):
            extra.append(QualityItem(
                code="outside_training_range", severity="WARN", feature_id=fid,
                message="Outside the range seen in the training cohort: allowed, but the profile is atypical "
                        "and model confidence is forced LOW.",
                details={"observed": observed.observed[fid]},
            ))
        return response.model_copy(update={"items": [*response.items, *extra]})

    def predict(self, req: PredictRequest) -> PredictionResponse:
        result = canonical_or_block(req)
        out = self.engine.predict(result.canonical)
        out["quality"]["notices"] = self._notices(result.input_sha256, None)
        return PredictionResponse(**self._identity(result.input_sha256, uuid.uuid4()), request_id=req.request_id,
                                  input_revision=req.input_revision, quality=out["quality"], targets=out["targets"])

    def analyze_full(self, req: AnalyzeFullRequest) -> AnalyzeFullResponse:
        result = canonical_or_block(req)
        out = self.engine.analyze(result.canonical)
        out["quality"]["notices"] = self._notices(result.input_sha256, req.dataset_record_id)
        return AnalyzeFullResponse(**self._identity(result.input_sha256, uuid.uuid4()), request_id=req.request_id,
                                   quality=out["quality"], targets=out["targets"], explanations=out["explanations"],
                                   evidence=out["evidence"])

    def explain(self, req: ExplainRequest) -> ExplanationResponse:
        result = check_pinned(req, self.model_version, self.artifact_sha)
        out = self.engine.analyze(result.canonical, only=req.target)
        return ExplanationResponse(**out["explanations"][req.target], **self._pinned(req))

    def sensitivity(self, req: SensitivityRequest) -> SensitivityResponse:
        result = check_pinned(req, self.model_version, self.artifact_sha)
        return SensitivityResponse(**self.engine.sensitivity(result.canonical, req.target), **self._pinned(req))

    def evidence(self, req: EvidenceRequest) -> EvidenceResponse:
        result = check_pinned(req, self.model_version, self.artifact_sha)
        out = self.engine.analyze(result.canonical, only=req.target)
        return EvidenceResponse(**out["evidence"][req.target], **self._pinned(req))

    def patients(self) -> PatientListResponse:
        items = [{k: p[k] for k in ("patient_id", "age", "sex", "key_risk_factors")} for p in self.index["patients"]]
        return PatientListResponse(patients=items, count=len(items))

    def patient(self, patient_id: str) -> PatientBundle:
        payload = self._patient_file(patient_id)["bundle"]
        if self.manifest.get("oof_ledger_method") != "outer_training_inner_crossfit":
            # Old reference-band membership used global OOF scores whose fits could include this query's label.
            # Preserve the actual held-out predictions/SHAP; never present that legacy ledger as held-out evidence.
            for evidence in payload["evidence"].values():
                evidence["evidence_ledger"].update(status="insufficient_evidence", n=0, positive_label_rate=None)
            payload["quality"].setdefault("notices", []).append({
                "code": "legacy_oof_ledger_withheld",
                "message": "Probability-band evidence withheld: this older bundle needs rebuilding with fold-safe evidence.",
            })
        return PatientBundle(**payload, app_version=APP_VERSION)

    def ground_truth(self, patient_id: str) -> GroundTruthResponse:
        return GroundTruthResponse(
            patient_id=patient_id, labels=self._patient_file(patient_id)["ground_truth"],
            label_definitions={t["id"]: t["label_definition"] for t in self.targets_cfg["targets"]},
        )

    def evaluation(self) -> EvaluationResponse:
        table1, table2 = [], []
        for t in TARGET_IDS:
            m = self.metrics["targets"][t]
            rows = [("nested_cv_selected", "model", m["model"])]
            rows += [(f"benchmark_{fam}", "model", s) for fam, s in m["benchmarks"].items()]
            rows += [(k, k, s) for k, s in m["baselines"].items()]
            for model, kind, summary in rows:
                metrics = {name: {"mean": v["mean"], "sd": v["sd"], "n_defined": v["n_defined"], "n_na": v["n_na"]}
                           for name, v in summary.items()}
                table1.append({"target": t, "model": model, "kind": kind, "prevalence": m["prevalence"],
                               "metrics": metrics})
            t2 = m["table2"]
            table2.append({k: t2[k] for k in ("pct_high_positive", "ppv", "ppv_ci", "pct_high_negative", "npv",
                                              "npv_ci", "pct_low_confidence", "accuracy_high_confidence",
                                              "fn_high_negative", "fp_high_positive")} | {"target": t})
        figures = {
            t: {**self.metrics["targets"][t].get("figures", {}),
                "selected_families": self.metrics["targets"][t]["selected_families"],
                "calibration_guard_events": self.metrics["targets"][t]["calibration_guard_events"],
                "table2_auc": self.metrics["targets"][t]["table2"]["auc"],
                "table2_auc_ci": self.metrics["targets"][t]["table2"]["auc_ci"]}
            for t in TARGET_IDS
        }
        return EvaluationResponse(model_version=self.model_version, table1=table1, table2=table2, figures=figures)

    def global_importance(self, target: str) -> GlobalImportanceResponse:
        return GlobalImportanceResponse(target=target, scope="OOF fold-specific model attribution distribution",
                                        features=self.importance[target])

    def models(self) -> ModelsResponse:
        registry = json.loads(REGISTRY_FILE.read_text(encoding="utf-8"))
        models = [{k: m.get(k) for k in ("version", "status", "created_at", "training_cases", "gate_status",
                                         "artifact_manifest_sha256")} for m in registry["models"]]
        return ModelsResponse(production_version=registry["production_version"],
                              deployed_version=self.manifest["model_version"], models=models,
                              **lifecycle_view(REGISTRY_FILE.parent))

    def model_report(self, version: str) -> ModelReportResponse:
        return gate_report(json.loads(REGISTRY_FILE.read_text(encoding="utf-8")), version, ROOT)

    def replay(self) -> ReplayResponse:
        return replay_study(REGISTRY_FILE.parent)
