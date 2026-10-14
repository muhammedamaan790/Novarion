"""Deploy NOVARION to a Hugging Face Docker Space (D-029).

Stages exactly what the Space image needs (source, the production model bundle, deploy/hosted/*) into a folder,
then uploads it. The sign-in accounts never enter the Space files: they go into the NOVARION_USERS_JSON Space
secret, as salted scrypt hashes.

Usage:
  uv run python scripts/deploy_space.py stage OUT_DIR                 # stage only (e.g. to test with docker build)
  uv run python scripts/deploy_space.py judge-account OUT_FILE        # new 'judge' account, strong random password
  uv run python scripts/deploy_space.py upload USER/SPACE --users USERS_JSON   # stage + create/update the Space
Upload needs `hf auth login` with a write token first.
"""

from __future__ import annotations

import json
import secrets
import shutil
import string
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.auth import hash_password, save_users

FILES = ["pyproject.toml", "uv.lock", "release_manifest.json"]
DIRS = ["ml", "backend", "config", "contracts", "registry", "frontend", "deploy/hosted"]
SKIP = shutil.ignore_patterns(
    "node_modules",
    "dist",
    "test-results",
    "playwright-report",
    "__pycache__",
    "*.tsbuildinfo",
    ".vite",
    "e2e",
)

SPACE_README = """---
title: NOVARION
emoji: 🫀
colorFrom: green
colorTo: red
sdk: docker
app_port: 7860
pinned: false
short_description: Coronary risk, artery by artery, on a 3D heart
---

# NOVARION

Estimates coronary artery disease and LAD, LCX and RCA stenosis from routine clinical measurements, shows them on a
3D heart, and explains every prediction. Multimodal AI Hackathon 2026, Track A.

Source, method and results: https://github.com/muhammedamaan790/Novarion

Decision support / educational purposes only. Not a substitute for formal diagnostic imaging.
"""


def production_bundle() -> str:
    registry = json.loads((ROOT / "registry" / "models.json").read_text(encoding="utf-8"))
    entry = next(m for m in registry["models"] if m["version"] == registry["production_version"])
    return entry["path"]


def stage(out: Path) -> Path:
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    for f in FILES:
        shutil.copy2(ROOT / f, out / f)
    for d in DIRS:
        shutil.copytree(ROOT / d, out / d, ignore=SKIP)
    bundle = production_bundle()
    if bundle != "artifacts/models/v1.0.2":
        raise SystemExit(f"production is {bundle}; update deploy/hosted/Dockerfile to copy that bundle")
    shutil.copytree(ROOT / bundle, out / "deploy" / "hosted" / "model", dirs_exist_ok=True)
    shutil.copy2(ROOT / "deploy" / "hosted" / "Dockerfile", out / "Dockerfile")
    (out / ".dockerignore").write_text("**/__pycache__\n**/node_modules\n", encoding="utf-8")
    (out / "README.md").write_text(SPACE_README, encoding="utf-8", newline="\n")
    # The Space builds from a git repo: keep the start script with LF line endings.
    start = out / "deploy" / "hosted" / "start.sh"
    start.write_bytes(start.read_bytes().replace(b"\r\n", b"\n"))
    return out


def judge_account(out: Path) -> None:
    alphabet = string.ascii_letters + string.digits
    password = "".join(secrets.choice(alphabet) for _ in range(16))
    save_users(out, {"judge": hash_password(password)})
    print(
        f"username: judge\npassword: {password}\nhashes written to {out} (keep the password; it is not stored)"
    )


def upload(repo_id: str, users: Path) -> None:
    from huggingface_hub import HfApi

    api = HfApi()
    with tempfile.TemporaryDirectory() as tmp:
        folder = stage(Path(tmp) / "space")
        api.create_repo(repo_id, repo_type="space", space_sdk="docker", exist_ok=True)
        api.add_space_secret(repo_id, "NOVARION_USERS_JSON", users.read_text(encoding="utf-8"))
        api.upload_folder(
            repo_id=repo_id, repo_type="space", folder_path=str(folder), commit_message="Deploy NOVARION"
        )
    print(f"https://huggingface.co/spaces/{repo_id}")


def main(argv: list[str]) -> int:
    if len(argv) == 2 and argv[0] == "stage":
        print(stage(Path(argv[1])))
    elif len(argv) == 2 and argv[0] == "judge-account":
        judge_account(Path(argv[1]))
    elif len(argv) == 4 and argv[0] == "upload" and argv[2] == "--users":
        upload(argv[1], Path(argv[3]))
    else:
        print(__doc__)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
