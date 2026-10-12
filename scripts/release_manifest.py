"""Release manifest (plan §11A "release_manifest.json (written at release freeze, never edited)") → release_manifest.json.

Pins every input that defines a release: model artifact manifest, feature/target/train/gate/replay/anatomy/demo
configs, both lockfiles, the offline demo bundle, the git commit and the frontend runtime versions. Without
--final it writes a release CANDIDATE (freeze_status "CANDIDATE"); with --final it refuses a dirty working tree and
an existing FINAL manifest, because after the freeze any change to the model, features, anatomy, thresholds,
explanations, API or demo patients requires a new version.
Usage: uv run python scripts/release_manifest.py [--final]
"""

from __future__ import annotations

import hashlib
import json
import platform
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "release_manifest.json"


def sha(path: Path) -> str:
    """Content hash with line endings normalized for text files (a Windows checkout must not change it)."""
    data = path.read_bytes()
    if path.suffix in {".json", ".yaml", ".yml", ".lock", ".toml", ".md"}:
        data = data.replace(b"\r\n", b"\n")
    return hashlib.sha256(data).hexdigest()


def git(*args: str) -> str:
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()


def main() -> int:
    final = "--final" in sys.argv
    if final:
        if OUT.exists() and json.loads(OUT.read_text(encoding="utf-8")).get("freeze_status") == "FINAL":
            print("refused: a FINAL release manifest already exists; a change needs a new version")
            return 2
        if git("status", "--porcelain"):
            print("refused: commit everything first (the manifest pins the git commit)")
            return 2
    registry = json.loads((ROOT / "registry" / "models.json").read_text(encoding="utf-8"))
    entry = next(m for m in registry["models"] if m["version"] == registry["production_version"])
    bundle_manifest = json.loads((ROOT / entry["path"] / "manifest.json").read_text(encoding="utf-8"))
    demo_index = json.loads((ROOT / entry["path"] / "demo_bundle" / "index.json").read_text(encoding="utf-8"))
    package = json.loads((ROOT / "frontend" / "package.json").read_text(encoding="utf-8"))
    deps = {**package.get("dependencies", {}), **package.get("devDependencies", {})}
    node = subprocess.run(["node", "--version"], capture_output=True, text=True, check=False).stdout.strip()
    config = ROOT / "config"
    manifest = {
        "release_version": registry["production_version"],
        "git_sha": git("rev-parse", "HEAD"),
        "artifact_manifest_sha256": bundle_manifest["artifact_manifest_sha256"],
        "feature_registry_sha256": sha(config / "feature_registry.yaml"),
        "target_schema_sha256": sha(config / "targets.yaml"),
        "train_config_sha256": sha(config / "train.yaml"),
        "promotion_gate_sha256": sha(config / "promotion_gate.yaml"),
        "replay_config_sha256": sha(config / "replay.yaml"),
        "anatomy_manifest_sha256": sha(config / "anatomy_manifest.json"),
        "anatomy_map_sha256": sha(config / "anatomy_map.json"),
        "demo_config_sha256": sha(config / "demo_config.yaml"),
        "frontend_lock_sha256": sha(ROOT / "frontend" / "package-lock.json"),
        "backend_lock_sha256": sha(ROOT / "uv.lock"),
        "demo_bundle_sha256": demo_index["demo_bundle_sha256"],
        "training_data_sha256": bundle_manifest["manifest"]["training_data_sha256"],
        "runtime": {"python": platform.python_version(), "node": node,
                    **{name: deps.get(name) for name in ("react", "@react-three/fiber", "@react-three/drei", "three")}},
        "created_at": datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "freeze_status": "FINAL" if final else "CANDIDATE",
    }
    OUT.write_text(json.dumps(manifest, indent=1) + "\n", encoding="utf-8")
    print(f"release_manifest.json written: v{manifest['release_version']} {manifest['freeze_status']} "
          f"@ {manifest['git_sha'][:10]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
