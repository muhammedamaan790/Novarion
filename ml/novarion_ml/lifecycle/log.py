"""Append-only, tamper-evident lifecycle log (plan §12B "Audit log + rollback", §11A "Lifecycle log hash").

One JSON line per event. entry_hash = SHA-256(prev_entry_hash ‖ JCS(entry without entry_hash)); the first entry
chains from GENESIS. Editing, reordering or removing any earlier line breaks every later hash (`verify`).
Limit (audit R20): deleting the newest lines leaves a shorter chain that still verifies. Detecting that needs the
last entry_hash kept somewhere else (e.g. in a release note or commit); this log does not do that by itself.
"""

from __future__ import annotations

import hashlib
import json
import os
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import rfc8785

GENESIS = "0" * 64
EVENTS = ("verify_outcomes", "candidate", "promote", "reject", "rollback")


class LogIntegrityError(RuntimeError):
    pass


def now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def sha256_jcs(obj: Any) -> str:
    return hashlib.sha256(rfc8785.dumps(obj)).hexdigest()


def _entry_hash(prev: str, body: dict[str, Any]) -> str:
    return hashlib.sha256(prev.encode("ascii") + rfc8785.dumps(body)).hexdigest()


class LifecycleLog:
    def __init__(self, path: Path):
        self.path = path

    def entries(self) -> list[dict[str, Any]]:
        if not self.path.exists():
            return []
        return [json.loads(line) for line in self.path.read_text(encoding="utf-8").splitlines() if line.strip()]

    def verify(self) -> list[dict[str, Any]]:
        """Re-derive the chain; raise on any modified, reordered or removed entry. Returns the entries."""
        prev = GENESIS
        entries = self.entries()
        for i, e in enumerate(entries):
            body = {k: v for k, v in e.items() if k != "entry_hash"}
            if e.get("seq") != i or e.get("prev_entry_hash") != prev or _entry_hash(prev, body) != e.get("entry_hash"):
                raise LogIntegrityError(f"lifecycle log broken at line {i + 1} ({self.path})")
            prev = e["entry_hash"]
        return entries

    def append(self, event: str, actor: str, details: dict[str, Any]) -> dict[str, Any]:
        if event not in EVENTS:
            raise ValueError(f"unknown lifecycle event {event!r}")
        if not actor.strip():
            raise ValueError("every lifecycle event needs an actor (steward / approver name)")
        entries = self.verify()  # never extend a broken chain
        prev = entries[-1]["entry_hash"] if entries else GENESIS
        body = {"seq": len(entries), "timestamp": now(), "event": event, "actor": actor, "details": details,
                "prev_entry_hash": prev}
        entry = {**body, "entry_hash": _entry_hash(prev, body)}
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a", encoding="utf-8", newline="\n") as fh:
            fh.write(json.dumps(entry, ensure_ascii=False, separators=(",", ":")) + "\n")
            fh.flush()
            os.fsync(fh.fileno())
        return entry

    def has_hash(self, event: str, key: str, value: str) -> bool:
        return any(e["event"] == event and e["details"].get(key) == value for e in self.verify())
