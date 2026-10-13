"""Username + password sign-in (D-022).

Accounts live in a JSON file outside git (default artifacts/users.json, NOVARION_USERS_FILE overrides), written only
by scripts/users.py: salted scrypt hashes, never passwords. Sign-in returns an HttpOnly, SameSite=Strict session
cookie; sessions are in memory, so a restart signs everyone out. With no accounts file, sign-in is off and the API
stays open (dev servers and tests); the frontend asks /auth/session which case applies.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import tempfile
import threading
from pathlib import Path

USERNAME_RE = re.compile(r"^[a-z0-9._-]{3,32}$")
MIN_PASSWORD_CHARS = 8
SCRYPT_PARAMS = {"n": 2**14, "r": 8, "p": 1}
SESSION_COOKIE = "novarion_session"
SESSION_TTL_S = 8 * 3600
MAX_SESSIONS = 1000
MAX_FAILURES = 5  # per username, then locked for LOCKOUT_S
LOCKOUT_S = 60.0


def _scrypt(password: str, salt: bytes, n: int, r: int, p: int) -> bytes:
    return hashlib.scrypt(password.encode("utf-8"), salt=salt, n=n, r=r, p=p, dklen=32)


def hash_password(password: str) -> dict:
    salt = secrets.token_bytes(16)
    return {"salt": salt.hex(), "hash": _scrypt(password, salt, **SCRYPT_PARAMS).hex(), **SCRYPT_PARAMS}


# Unknown usernames are checked against this, so a wrong name costs the same time as a wrong password.
_DUMMY = hash_password(secrets.token_hex(16))


def verify_password(record: dict, password: str) -> bool:
    digest = _scrypt(password, bytes.fromhex(record["salt"]), record["n"], record["r"], record["p"])
    return hmac.compare_digest(digest, bytes.fromhex(record["hash"]))


def load_users(path: Path) -> dict[str, dict]:
    if not path.exists():
        return {}
    doc = json.loads(path.read_text(encoding="utf-8"))
    return dict(doc.get("users", {}))


def save_users(path: Path, users: dict[str, dict]) -> None:
    """Atomic write: a crash never leaves a half-written accounts file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump({"version": 1, "users": users}, fh, indent=2, sort_keys=True)
    os.replace(tmp, path)


class Authenticator:
    def __init__(self, users_file: Path | None):
        self.users_file = users_file
        self.enabled = bool(users_file and users_file.exists())
        self.users = load_users(users_file) if self.enabled and users_file else {}
        self._sessions: dict[str, tuple[str, float]] = {}  # token → (username, expiry)
        self._failures: dict[str, tuple[int, float]] = {}  # username → (count, locked_until)
        self._lock = threading.Lock()

    def retry_after(self, username: str, now: float) -> float:
        with self._lock:
            count, until = self._failures.get(username, (0, 0.0))
        return until - now if count >= MAX_FAILURES and until > now else 0.0

    def login(self, username: str, password: str, now: float) -> str | None:
        """A new session token, or None. Callers check retry_after first."""
        record = self.users.get(username)
        ok = verify_password(record or _DUMMY, password) and record is not None
        with self._lock:
            if not ok:
                count, _ = self._failures.get(username, (0, 0.0))
                count += 1
                self._failures[username] = (count, now + LOCKOUT_S if count >= MAX_FAILURES else 0.0)
                if len(self._failures) > MAX_SESSIONS:
                    self._failures.clear()
                return None
            self._failures.pop(username, None)
            if len(self._sessions) >= MAX_SESSIONS:
                self._sessions = {t: s for t, s in self._sessions.items() if s[1] > now}
                if len(self._sessions) >= MAX_SESSIONS:
                    self._sessions.pop(min(self._sessions, key=lambda t: self._sessions[t][1]))
            token = secrets.token_urlsafe(32)
            self._sessions[token] = (username, now + SESSION_TTL_S)
            return token

    def user_for(self, token: str | None, now: float) -> str | None:
        if not token:
            return None
        with self._lock:
            session = self._sessions.get(token)
            if session and session[1] <= now:
                del self._sessions[token]
                return None
        return session[0] if session else None

    def logout(self, token: str | None) -> None:
        if token:
            with self._lock:
                self._sessions.pop(token, None)
