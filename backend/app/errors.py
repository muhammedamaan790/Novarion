"""One error envelope for every endpoint (plan §11A). No stack traces, no echoed inputs."""

from __future__ import annotations

import logging
import uuid
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from .schemas import ErrorResponse

log = logging.getLogger("novarion")

STATUS = {
    "VALIDATION_FAILED": 422, "INPUT_OUT_OF_RANGE": 422, "UNSEEN_CATEGORY": 422, "UNIT_MISMATCH": 422,
    "QUALITY_GATE_BLOCKED": 422, "INPUT_HASH_MISMATCH": 409, "ARTIFACT_MISMATCH": 409, "NOT_READY": 503,
    "TARGET_FAILED": 500, "PAYLOAD_TOO_LARGE": 413, "RATE_LIMITED": 429, "NOT_FOUND": 404, "INTERNAL_ERROR": 500,
    "FORBIDDEN": 403, "PROMOTION_REFUSED": 409,
}


class ApiError(HTTPException):
    """Subclasses HTTPException so FastAPI's body-parsing block re-raises it instead of masking it as a 400."""

    def __init__(self, error_code: str, message: str, details: dict[str, Any] | None = None, **extra: Any):
        super().__init__(status_code=STATUS[error_code], detail=message)
        self.body = ErrorResponse(error_code=error_code, message=message, details=details or {}, **extra)

    @property
    def status(self) -> int:
        return STATUS[self.body.error_code]


def _response(body: ErrorResponse, status: int, request: Request) -> JSONResponse:
    request_id = getattr(request.state, "request_id", None)
    if body.request_id is None and request_id:
        try:
            body = body.model_copy(update={"request_id": uuid.UUID(request_id)})
        except ValueError:
            pass  # not a valid UUID: never echo it
    return JSONResponse(status_code=status, content=body.model_dump(mode="json"))


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(request: Request, exc: ApiError) -> JSONResponse:
        return _response(exc.body, exc.status, request)

    @app.exception_handler(RequestValidationError)
    async def _validation(request: Request, exc: RequestValidationError) -> JSONResponse:
        errors = [
            {"loc": [str(p) for p in e.get("loc", ())], "msg": str(e.get("msg", ""))[:256], "type": e.get("type", "")}
            for e in exc.errors()[:50]
        ]  # never echo the submitted input values
        reason = "schema_version" if any("api_schema_version" in err["loc"] for err in errors) else "request_schema"
        body = ErrorResponse(error_code="VALIDATION_FAILED", message="Request failed validation.",
                             details={"reason": reason, "errors": errors})
        return _response(body, 422, request)

    @app.exception_handler(StarletteHTTPException)
    async def _http(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        mapped = {404: "NOT_FOUND", 405: "NOT_FOUND", 413: "PAYLOAD_TOO_LARGE", 429: "RATE_LIMITED"}
        code = mapped.get(exc.status_code, "VALIDATION_FAILED" if exc.status_code < 500 else "INTERNAL_ERROR")
        status = exc.status_code if exc.status_code in mapped else STATUS[code]
        return _response(ErrorResponse(error_code=code, message=code.replace("_", " ").capitalize()), status, request)

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception) -> JSONResponse:
        log.exception("unhandled error")  # server-side log only; the client never sees a trace
        return _response(ErrorResponse(error_code="INTERNAL_ERROR", message="Internal error."), 500, request)
