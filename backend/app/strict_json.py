"""Strict JSON request parsing (plan §11 "Strict input contract", §11A size limits).

Before Pydantic sees the body, this rejects: bodies > 64 KB, duplicate keys, NaN/±Infinity literals, nesting > 6,
strings > 256 chars. (The standard json.loads silently keeps the last duplicate key and accepts NaN.)
"""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

from fastapi import Request, Response
from fastapi.routing import APIRoute

from .errors import ApiError
from .settings import MAX_BODY_BYTES, MAX_JSON_DEPTH, MAX_STRING_CHARS


def _no_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in pairs:
        if key in out:
            raise ApiError("VALIDATION_FAILED", "Duplicate JSON key.", {"reason": "duplicate_key", "key": key[:64]})
        out[key] = value
    return out


def _reject_constant(name: str) -> Any:
    raise ApiError("VALIDATION_FAILED", "Non-finite numbers are not allowed.", {"reason": "non_finite", "token": name})


def _check_shape(value: Any, depth: int = 1) -> None:
    if depth > MAX_JSON_DEPTH:
        raise ApiError("VALIDATION_FAILED", "JSON nesting too deep.", {"reason": "depth", "max_depth": MAX_JSON_DEPTH})
    if isinstance(value, dict):
        for k, v in value.items():
            if len(k) > MAX_STRING_CHARS:
                raise ApiError("VALIDATION_FAILED", "Key too long.", {"reason": "string_length"})
            _check_shape(v, depth + 1)
    elif isinstance(value, list):
        for v in value:
            _check_shape(v, depth + 1)
    elif isinstance(value, str) and len(value) > MAX_STRING_CHARS:
        raise ApiError("VALIDATION_FAILED", "String too long.", {"reason": "string_length", "max": MAX_STRING_CHARS})


def _lenient_request_id(raw: bytes) -> Any:
    """Best-effort request_id from a body the strict parser rejected, so the error can still be correlated."""
    if len(raw) > MAX_BODY_BYTES:
        return None
    try:
        value = json.loads(raw)
    except (ValueError, RecursionError):
        return None
    return value.get("request_id") if isinstance(value, dict) else None


def parse_strict_json(raw: bytes) -> Any:
    if len(raw) > MAX_BODY_BYTES:
        raise ApiError("PAYLOAD_TOO_LARGE", "Request body too large.", {"max_bytes": MAX_BODY_BYTES})
    try:
        value = json.loads(raw, object_pairs_hook=_no_duplicates, parse_constant=_reject_constant)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise ApiError("VALIDATION_FAILED", "Malformed JSON.", {"reason": "malformed_json"}) from exc
    _check_shape(value)
    return value


class StrictJSONRequest(Request):
    async def body(self) -> bytes:
        if not hasattr(self, "_body"):
            declared = self.headers.get("content-length")
            if declared and declared.isdigit() and int(declared) > MAX_BODY_BYTES:
                raise ApiError("PAYLOAD_TOO_LARGE", "Request body too large.", {"max_bytes": MAX_BODY_BYTES})
            chunks, size = [], 0
            async for chunk in self.stream():
                size += len(chunk)
                if size > MAX_BODY_BYTES:
                    raise ApiError("PAYLOAD_TOO_LARGE", "Request body too large.", {"max_bytes": MAX_BODY_BYTES})
                chunks.append(chunk)
            self._body = b"".join(chunks)
        return self._body

    async def json(self) -> Any:
        if not hasattr(self, "_json"):
            raw = await self.body()
            try:
                self._json = parse_strict_json(raw)
            except ApiError:
                self._remember_request_id(_lenient_request_id(raw))  # correlation only; the body stays rejected
                raise
            if isinstance(self._json, dict):
                self._remember_request_id(self._json.get("request_id"))
        return self._json

    def _remember_request_id(self, value: Any) -> None:
        if isinstance(value, str):
            self.state.request_id = value[:64]  # echoed only if it is a valid UUID (errors._response)


class StrictJSONRoute(APIRoute):
    def get_route_handler(self) -> Callable:
        handler = super().get_route_handler()

        async def strict_handler(request: Request) -> Response:
            return await handler(StrictJSONRequest(request.scope, request.receive))

        return strict_handler
