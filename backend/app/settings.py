"""Frozen runtime limits and run-mode settings (plan §11A "Frozen size limits"). Tested in tests/test_api_contract.py."""

from __future__ import annotations

import os
from dataclasses import dataclass, field

APP_VERSION = "0.1.0"
MAX_BODY_BYTES = 64 * 1024
MAX_JSON_DEPTH = 6
MAX_STRING_CHARS = 256
MAX_FEATURES_PER_REQUEST = 100


@dataclass(frozen=True)
class Settings:
    run_mode: str = "live"  # "live" (hosted) | "local" (Docker); /promote exists only in local mode
    mock: bool = False
    cors_origins: tuple[str, ...] = field(default_factory=tuple)
    # Token bucket per client (plan §11 "rate limiting"): generous enough for 300 ms debounced live editing.
    rate_limit_per_minute: int = 600
    rate_limit_burst: int = 200
    trust_proxy: bool = False  # only behind our own nginx: take the client address from X-Real-IP
    admin_token: str | None = None  # local mode: enables the in-app Promote wrapper (NOVARION_ADMIN_TOKEN)

    @classmethod
    def from_env(cls) -> Settings:
        origins = tuple(o.strip() for o in os.environ.get("NOVARION_CORS_ORIGINS", "").split(",") if o.strip())
        if "*" in origins:
            raise ValueError("NOVARION_CORS_ORIGINS must list exact origins, never '*'")
        run_mode = os.environ.get("NOVARION_RUN_MODE", "live")
        if run_mode not in {"live", "local"}:
            raise ValueError("NOVARION_RUN_MODE must be 'live' or 'local'")
        return cls(run_mode=run_mode, mock=os.environ.get("NOVARION_MOCK") == "1", cors_origins=origins,
                   rate_limit_per_minute=int(os.environ.get("NOVARION_RATE_LIMIT_PER_MIN", "600")),
                   rate_limit_burst=int(os.environ.get("NOVARION_RATE_LIMIT_BURST", "200")),
                   trust_proxy=os.environ.get("NOVARION_TRUST_PROXY") == "1",
                   admin_token=os.environ.get("NOVARION_ADMIN_TOKEN") or None)
