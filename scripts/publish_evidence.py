"""Publish the static Model Evidence files for the frontend, each bound to the model it describes (audit R08/R09).

Writes frontend/public/evidence/{clinical_evaluation,displayed_tiers}.json as
  {"identity": {model_version, artifact_manifest_sha256, scope}, "data": <the result file>}.
The page compares identity.model_version with the active model and labels any mismatch as historical evidence
(e.g. after a promotion, or against the contract mock); it never presents it as validation of another model.
Refuses to publish results that name a different model than the production bundle.
Usage: uv run python scripts/publish_evidence.py
"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "frontend" / "public" / "evidence"

SOURCES = {
    "displayed_tiers": ("results/displayed_tiers.json",
                        "confidence tiers as displayed after every gate: served out-of-fold analyses of this model"),
    "clinical_evaluation": ("results/clinical_evaluation.json",
                            ("guideline comparator and subgroups, computed from the nested-CV out-of-fold predictions "
                             "of the training run behind this model")),
}


def production_identity() -> dict:
    registry = json.loads((ROOT / "registry" / "models.json").read_text(encoding="utf-8"))
    entry = next(m for m in registry["models"] if m["version"] == registry["production_version"])
    doc = json.loads((ROOT / entry["path"] / "manifest.json").read_text(encoding="utf-8"))
    return {"model_version": doc["manifest"]["model_version"], "artifact_manifest_sha256": doc["artifact_manifest_sha256"]}


def publish() -> None:
    identity = production_identity()
    OUT.mkdir(parents=True, exist_ok=True)
    for name, (source, scope) in SOURCES.items():
        data = json.loads((ROOT / source).read_text(encoding="utf-8"))
        named = data.get("model_version")
        if named is not None and named != identity["model_version"]:
            raise SystemExit(f"refused: {source} is for model {named}, production is {identity['model_version']}")
        out = {"identity": {**identity, "scope": scope, "source": source}, "data": data}
        (OUT / f"{name}.json").write_text(json.dumps(out, indent=1) + "\n", encoding="utf-8", newline="\n")
        print(f"{OUT.relative_to(ROOT) / (name + '.json')}: model v{identity['model_version']}")


if __name__ == "__main__":
    publish()
