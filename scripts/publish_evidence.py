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


TRAINING_RUN = ("split_manifest_sha256", "training_data_sha256", "train_config_sha256")  # what identifies a training run in a bundle manifest


def production_identity() -> dict:
    registry = json.loads((ROOT / "registry" / "models.json").read_text(encoding="utf-8"))
    entry = next(m for m in registry["models"] if m["version"] == registry["production_version"])
    doc = json.loads((ROOT / entry["path"] / "manifest.json").read_text(encoding="utf-8"))
    return {"model_version": doc["manifest"]["model_version"], "artifact_manifest_sha256": doc["artifact_manifest_sha256"],
            "training_run": {k: doc["manifest"].get(k) for k in TRAINING_RUN}}


def binding_problem(identity: dict, data: dict, source: str) -> str | None:
    """Evidence is published only for the model it was computed for (audit N05). The identity must come from the
    computation itself (`source_identity`), never from this publisher: unversioned data is refused, not stamped."""
    src = data.get("source_identity")
    if not isinstance(src, dict):
        return f"{source} records no source identity; regenerate it with the script that computes it"
    if src.get("kind") == "bundle":
        if (src.get("model_version"), src.get("artifact_manifest_sha256")) != (
                identity["model_version"], identity["artifact_manifest_sha256"]):
            return (f"{source} was computed from bundle v{src.get('model_version')} "
                    f"({str(src.get('artifact_manifest_sha256'))[:12]}), not the production bundle "
                    f"v{identity['model_version']} ({identity['artifact_manifest_sha256'][:12]})")
        return None
    if src.get("kind") == "training_run":
        differing = [k for k in TRAINING_RUN if not identity["training_run"].get(k) or src.get(k) != identity["training_run"][k]]
        if differing:
            return (f"{source} was computed from another training run than the production bundle was built from "
                    f"(differing: {', '.join(differing)})")
        return None
    return f"{source} has an unknown source identity kind {src.get('kind')!r}"


def publish() -> None:
    identity = production_identity()
    OUT.mkdir(parents=True, exist_ok=True)
    for name, (source, scope) in SOURCES.items():
        data = json.loads((ROOT / source).read_text(encoding="utf-8"))
        problem = binding_problem(identity, data, source)
        if problem:
            raise SystemExit(f"refused: {problem}")
        out = {"identity": {"model_version": identity["model_version"],
                            "artifact_manifest_sha256": identity["artifact_manifest_sha256"],
                            "basis": data["source_identity"], "scope": scope, "source": source}, "data": data}
        (OUT / f"{name}.json").write_text(json.dumps(out, indent=1) + "\n", encoding="utf-8", newline="\n")
        print(f"{OUT.relative_to(ROOT) / (name + '.json')}: model v{identity['model_version']}")


if __name__ == "__main__":
    publish()
