"""One-time migration of the training cache key to line-ending-independent hashing (D-020).

The old key hashed raw config bytes, so a CRLF checkout (Windows) and an LF checkout (Linux) of the same commit got
different keys. The new key hashes LF-normalized content. This script re-stamps stored results ONLY where it can
prove they were produced from exactly the current config content: a record is migrated iff its stored key equals the
OLD raw-byte key of the current files. Anything else is refused (that would need a real rerun).
Usage: uv run --group train python scripts/migrate_cache_key.py
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "ml"))

from scripts.train import CONFIG_DIR, cache_key


def old_raw_key() -> str:
    parts = [hashlib.sha256((CONFIG_DIR / "train.yaml").read_bytes()).hexdigest()]
    for name in ("feature_registry.yaml", "targets.yaml", "data_source.json"):
        parts.append(hashlib.sha256((CONFIG_DIR / name).read_bytes()).hexdigest())
    return hashlib.sha256("|".join(parts).encode()).hexdigest()


def main() -> int:
    old, new = old_raw_key(), cache_key()
    if old == new:
        print("nothing to migrate: the config files are already LF")
        return 0
    files = [ROOT / "results" / "metrics.json", *sorted((ROOT / "results" / "final").glob("*.json")),
             *sorted((ROOT / "results" / "nested").glob("*/*.json"))]
    refused = [f for f in files if json.loads(f.read_text(encoding="utf-8")).get("cache_key") not in (old, new)]
    if refused:
        print(f"refused: {len(refused)} record(s) were not produced from the current config content, e.g. {refused[:3]}")
        return 2
    migrated = 0
    for f in files:
        text = f.read_text(encoding="utf-8")
        doc = json.loads(text)
        if doc["cache_key"] == old:
            f.write_text(text.replace(old, new), encoding="utf-8")
            migrated += 1
    print(f"migrated {migrated} record(s): {old[:12]}… (raw bytes) -> {new[:12]}… (LF-normalized)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
