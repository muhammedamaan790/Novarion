"""Export the OFFLINE DEMO bundle for the frontend (plan §10 run modes, §11A "Offline bundle").

Copies the production bundle's demo_bundle/ (index.json + one file per dataset patient, with ground truth that the UI
hides until the explicit reveal) to frontend/public/demo_bundle/, plus static snapshots of /meta and /evaluation, so
the app can run every dataset-patient flow with no backend. The index keeps its demo_bundle_sha256 (JCS), which the
frontend verifies before use. Usage: uv run --group inference python scripts/export_demo_bundle.py
"""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "ml"), str(ROOT / "backend")]

from app.bundle_service import BundleService, production_bundle_dir, verify_bundle
from app.settings import Settings

OUT = ROOT / "frontend" / "public" / "demo_bundle"


def main() -> None:
    bundle_dir = production_bundle_dir()
    verify_bundle(bundle_dir)  # never export a modified bundle
    service = BundleService(Settings())
    if OUT.exists():
        shutil.rmtree(OUT)
    shutil.copytree(bundle_dir / "demo_bundle", OUT)
    (OUT / "meta.json").write_text(service.meta().model_dump_json(), encoding="utf-8")
    (OUT / "evaluation.json").write_text(service.evaluation().model_dump_json(), encoding="utf-8")
    (OUT / "models.json").write_text(service.models().model_dump_json(), encoding="utf-8")  # Model Center, read-only
    if (ROOT / "registry" / "replay.json").exists():
        (OUT / "replay.json").write_text(service.replay().model_dump_json(), encoding="utf-8")
    size = sum(p.stat().st_size for p in OUT.rglob("*") if p.is_file())
    index = json.loads((OUT / "index.json").read_text(encoding="utf-8"))
    print(f"offline demo bundle -> {OUT.relative_to(ROOT)}: model v{index['index']['model_version']}, "
          f"{len(index['index']['patients'])} patients, {size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
