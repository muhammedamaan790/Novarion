"""NOVARION API (plan §11). Run: `uv run --group inference uvicorn app.main:app --app-dir backend`.

Environment: NOVARION_MOCK=1 serves the contract mocks; NOVARION_RUN_MODE=live|local; NOVARION_CORS_ORIGINS=exact
origins (comma-separated, never "*"). Without a verified model bundle the service fails closed (NOT_READY).
"""

from __future__ import annotations

import hmac
import json
import logging
import subprocess
import sys
import time
from typing import Annotated

from fastapi import APIRouter, Depends, FastAPI, Path, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .errors import ApiError, install_error_handlers
from .schemas import (
    AnalyzeFullRequest,
    AnalyzeFullResponse,
    ErrorResponse,
    EvaluationResponse,
    EvidenceRequest,
    EvidenceResponse,
    ExplainRequest,
    ExplanationResponse,
    GlobalImportanceResponse,
    GroundTruthResponse,
    HealthLive,
    HealthReady,
    MetaResponse,
    ModelReportResponse,
    ModelsResponse,
    PatientBundle,
    PatientListResponse,
    PredictionResponse,
    PredictRequest,
    PromoteRequest,
    PromoteResponse,
    ReplayResponse,
    SensitivityRequest,
    SensitivityResponse,
    TargetId,
    ValidateRequest,
    ValidateResponse,
)
from .service import InferenceService, UnavailableService
from .settings import APP_VERSION, Settings
from .strict_json import StrictJSONRoute

API_PREFIX = "/api/v1"
PatientPath = Annotated[str, Path(pattern=r"^ZAS-\d{4}$")]
VersionPath = Annotated[str, Path(pattern=r"^\d+\.\d+\.\d+$")]
ERROR_RESPONSES = {
    code: {"model": ErrorResponse} for code in (404, 409, 413, 422, 429, 500, 503)
}
SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
    "Cross-Origin-Resource-Policy": "same-origin",
}


class RateLimiter:
    """Per-client token bucket. In-memory (single process); a bounded table so it cannot grow without limit."""

    MAX_CLIENTS = 10_000

    def __init__(self, per_minute: int, burst: int):
        self.rate = per_minute / 60.0
        self.burst = float(burst)
        self.buckets: dict[str, tuple[float, float]] = {}  # client → (tokens, last timestamp)

    def allow(self, client: str, now: float) -> tuple[bool, float]:
        tokens, last = self.buckets.get(client, (self.burst, now))
        tokens = min(self.burst, tokens + (now - last) * self.rate)
        if len(self.buckets) >= self.MAX_CLIENTS and client not in self.buckets:
            self.buckets.clear()  # crude but safe eviction: everyone gets a fresh bucket
        if tokens < 1.0:
            self.buckets[client] = (tokens, now)
            return False, (1.0 - tokens) / self.rate
        self.buckets[client] = (tokens - 1.0, now)
        return True, 0.0


def _client_key(request: Request, trust_proxy: bool) -> str:
    if trust_proxy and request.headers.get("x-real-ip"):
        return request.headers["x-real-ip"]
    return request.client.host if request.client else "unknown"


def _service(request: Request) -> InferenceService:
    return request.app.state.service


def build_router() -> APIRouter:
    router = APIRouter(prefix=API_PREFIX, route_class=StrictJSONRoute, responses=ERROR_RESPONSES)
    svc = Depends(_service)

    @router.get("/health/live", response_model=HealthLive, tags=["health"])
    def health_live() -> HealthLive:
        return HealthLive()

    @router.get("/health/ready", response_model=HealthReady, tags=["health"])
    def health_ready(response: Response, service: InferenceService = svc) -> HealthReady:
        ready = service.ready()
        if not ready.ready:
            response.status_code = 503
        return ready

    @router.get("/meta", response_model=MetaResponse, tags=["meta"])
    def meta(service: InferenceService = svc) -> MetaResponse:
        return service.meta()

    @router.get("/patients", response_model=PatientListResponse, tags=["patients"])
    def patients(service: InferenceService = svc) -> PatientListResponse:
        return service.patients()

    @router.get("/patients/{patient_id}", response_model=PatientBundle, tags=["patients"])
    def patient(patient_id: PatientPath, service: InferenceService = svc) -> PatientBundle:
        return service.patient(patient_id)

    @router.get("/patients/{patient_id}/ground-truth", response_model=GroundTruthResponse, tags=["patients"])
    def ground_truth(patient_id: PatientPath, service: InferenceService = svc) -> GroundTruthResponse:
        return service.ground_truth(patient_id)

    @router.post("/validate", response_model=ValidateResponse, tags=["analysis"])
    def validate(body: ValidateRequest, service: InferenceService = svc) -> ValidateResponse:
        return service.validate(body)

    @router.post("/predict", response_model=PredictionResponse, tags=["analysis"])
    def predict(body: PredictRequest, service: InferenceService = svc) -> PredictionResponse:
        return service.predict(body)

    @router.post("/analyze/full", response_model=AnalyzeFullResponse, tags=["analysis"])
    def analyze_full(body: AnalyzeFullRequest, service: InferenceService = svc) -> AnalyzeFullResponse:
        return service.analyze_full(body)

    @router.post("/explain", response_model=ExplanationResponse, tags=["analysis"])
    def explain(body: ExplainRequest, service: InferenceService = svc) -> ExplanationResponse:
        return service.explain(body)

    @router.post("/sensitivity", response_model=SensitivityResponse, tags=["analysis"])
    def sensitivity(body: SensitivityRequest, service: InferenceService = svc) -> SensitivityResponse:
        return service.sensitivity(body)

    @router.post("/evidence", response_model=EvidenceResponse, tags=["analysis"])
    def evidence(body: EvidenceRequest, service: InferenceService = svc) -> EvidenceResponse:
        return service.evidence(body)

    @router.get("/evaluation", response_model=EvaluationResponse, tags=["evidence"])
    def evaluation(service: InferenceService = svc) -> EvaluationResponse:
        return service.evaluation()

    @router.get("/global-importance/{target}", response_model=GlobalImportanceResponse, tags=["evidence"])
    def global_importance(target: TargetId, service: InferenceService = svc) -> GlobalImportanceResponse:
        return service.global_importance(target)

    @router.get("/models", response_model=ModelsResponse, tags=["models"])
    def models(service: InferenceService = svc) -> ModelsResponse:
        return service.models()

    @router.get("/models/replay", response_model=ReplayResponse, tags=["models"])
    def replay(service: InferenceService = svc) -> ReplayResponse:
        return service.replay()

    @router.get("/models/{version}/report", response_model=ModelReportResponse, tags=["models"])
    def model_report(version: VersionPath, service: InferenceService = svc) -> ModelReportResponse:
        return service.model_report(version)

    return router


def run_lifecycle_promote(version: str, approver: str) -> tuple[int, str]:
    """The in-app Promote button only wraps the authoritative CLI (plan §11A "The CLI is authoritative")."""
    from novarion_ml.data.registry import ROOT

    cmd = [sys.executable, str(ROOT / "scripts" / "lifecycle.py"), "promote", "--version", version, "--approver", approver]
    try:
        done = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=3600, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return 1, f"could not run the lifecycle CLI: {exc}"
    return done.returncode, (done.stdout + done.stderr).strip()[-400:]


def build_local_router(settings: Settings) -> APIRouter:
    """Routes that exist ONLY in local mode (plan §12B: the hosted demo has no promote route)."""
    router = APIRouter(prefix=API_PREFIX, route_class=StrictJSONRoute, responses=ERROR_RESPONSES)

    @router.post("/models/{version}/promote", response_model=PromoteResponse, tags=["models"])
    def promote(version: VersionPath, body: PromoteRequest, request: Request) -> PromoteResponse:
        supplied = request.headers.get("X-Novarion-Admin-Token", "")
        if not settings.admin_token or not hmac.compare_digest(supplied.encode(), settings.admin_token.encode()):
            raise ApiError("FORBIDDEN", "Promotion needs the local admin token (NOVARION_ADMIN_TOKEN).")
        code, output = request.app.state.promote_runner(version, body.approver)
        if code != 0:
            raise ApiError("PROMOTION_REFUSED", (output.splitlines() or ["refused"])[-1][:256])
        from .bundle_service import REGISTRY_FILE

        registry = json.loads(REGISTRY_FILE.read_text(encoding="utf-8"))
        return PromoteResponse(version=version, production_version=registry["production_version"],
                               message="Promoted by the lifecycle CLI and logged; restart the backend to deploy it.")

    return router


def default_service(settings: Settings) -> InferenceService:
    if settings.mock:
        from .mock import MockService

        return MockService(settings)
    try:
        from .bundle_service import BundleService

        return BundleService(settings)
    except Exception as exc:  # noqa: BLE001 — any load failure (missing, partial, modified) must fail closed
        logging.getLogger("novarion").error("model bundle not loaded: %s", exc)
        return UnavailableService(f"Model bundle failed integrity check or is missing: {type(exc).__name__}: {exc}"[:256])


def create_app(settings: Settings | None = None, service: InferenceService | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    local = settings.run_mode == "local"
    app = FastAPI(
        title="NOVARION API",
        version=APP_VERSION,
        description="Decision support / educational purposes only. Not a substitute for formal diagnostic imaging.",
        openapi_url=f"{API_PREFIX}/openapi.json",
        docs_url=f"{API_PREFIX}/docs" if local else None,
        redoc_url=None,
    )
    app.state.settings = settings
    app.state.service = service or default_service(settings)
    install_error_handlers(app)
    app.include_router(build_router())
    app.state.promote_runner = run_lifecycle_promote
    if local:
        app.include_router(build_local_router(settings))

    limiter = RateLimiter(settings.rate_limit_per_minute, settings.rate_limit_burst)

    @app.middleware("http")
    async def _headers(request: Request, call_next):
        if not request.url.path.startswith(f"{API_PREFIX}/health"):  # health checks are never throttled
            allowed, retry_after = limiter.allow(_client_key(request, settings.trust_proxy), time.monotonic())
            if not allowed:
                body = ErrorResponse(error_code="RATE_LIMITED", message="Too many requests; retry shortly.",
                                     details={"retry_after_s": round(retry_after, 2)})
                response = JSONResponse(status_code=429, content=body.model_dump(mode="json"),
                                        headers={"Retry-After": str(max(1, round(retry_after)))})
                for key, value in SECURITY_HEADERS.items():
                    response.headers.setdefault(key, value)
                return response
        response = await call_next(request)
        for key, value in SECURITY_HEADERS.items():
            response.headers.setdefault(key, value)
        if app.state.service.is_mock:
            response.headers["X-Novarion-Mock"] = "1"
        return response

    if settings.cors_origins:  # added last = outermost, so CORS headers also reach error responses
        app.add_middleware(
            CORSMiddleware, allow_origins=list(settings.cors_origins), allow_methods=["GET", "POST"],
            allow_headers=["Content-Type"], allow_credentials=False, max_age=600,
        )
    return app


app = create_app()
