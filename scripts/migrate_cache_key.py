"""One-time migration of stored training results to the R14 cache key (config + training code + training libraries).

History: D-020 moved the key to LF-normalized config hashing (done). Audit R14 then added the training code and the
locked training-library versions to the key, so a code or dependency change can no longer reuse old fits.

Stored results (results/metrics.json, results/final, results/nested) carry the pre-R14 key, which covered the config
only. They are re-stamped ONLY if this script can prove they still match the current training code and libraries:
  1. the record's key equals the current config-only key (the config did not change), and
  2. every training source file and the locked training-library versions at HEAD are byte-identical (LF-normalized) to
     those at VERIFIED_COMMIT, whose fresh-clone retrain reproduced every fold, metric and golden prediction exactly
     (D-020, results/reproduction.json).
Anything else is refused: that needs a real retrain (scripts/train.py; FORCE_RETRAIN=1 ignores the cache).
Usage: uv run --group train python scripts/migrate_cache_key.py
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "ml"))

from scripts.train import TRAINING_CODE, cache_key, code_identity, config_key, dependency_identity

VERIFIED_COMMIT = "9955a69"  # "Fresh-clone reproduction passes" (D-020)


def git(*args: str) -> bytes:
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, check=True).stdout


def code_identity_at(commit: str) -> str:
    """code_identity() computed from the files as they were at `commit`."""
    names = git("ls-tree", "-r", "--name-only", commit, "--", *TRAINING_CODE).decode().split()
    parts = []
    for name in sorted(n for n in names if n.endswith(".py")):
        content = git("show", f"{commit}:{name}").replace(b"\r\n", b"\n")
        parts.append(f"{name}:{hashlib.sha256(content).hexdigest()}")
    return hashlib.sha256("\n".join(parts).encode()).hexdigest()


def main() -> int:
    old, new = config_key(), cache_key()
    files = [ROOT / "results" / "metrics.json", *sorted((ROOT / "results" / "final").glob("*.json")),
             *sorted((ROOT / "results" / "nested").glob("*/*.json"))]
    keys = {f: json.loads(f.read_text(encoding="utf-8")).get("cache_key") for f in files}
    if all(k == new for k in keys.values()):
        print("nothing to migrate: every record already carries the current key")
        return 0
    refused = [f for f, k in keys.items() if k not in (old, new)]
    if refused:
        print(f"refused: {len(refused)} record(s) were not produced from the current config, e.g. {refused[:3]}")
        return 2
    if code_identity() != code_identity_at(VERIFIED_COMMIT):
        print(f"refused: the training code differs from {VERIFIED_COMMIT} (the reproduced commit); retrain instead")
        return 2
    if dependency_identity() != dependency_identity(git("show", f"{VERIFIED_COMMIT}:uv.lock").decode()):
        print(f"refused: the training libraries differ from {VERIFIED_COMMIT}; retrain instead")
        return 2
    migrated = 0
    for f, k in keys.items():
        if k == old:
            f.write_text(f.read_text(encoding="utf-8").replace(old, new), encoding="utf-8", newline="\n")
            migrated += 1
    print(f"migrated {migrated} record(s): {old[:12]}… (config only) -> {new[:12]}… (config + code + libraries); "
          f"training code and libraries proven identical to {VERIFIED_COMMIT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
