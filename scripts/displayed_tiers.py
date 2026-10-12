"""Table 2b: confidence tiers AS DISPLAYED (D-019, recommended by PR #1's audit) → results/displayed_tiers.json.

Table 2 measures the threshold regions. The app additionally forces LOW for unknown inputs, atypical profiles and
unstable stability intervals, so the HIGH badge a user sees covers a subset of each region. This script measures
that badge directly: every dataset patient's served out-of-fold analysis (production bundle) against its label,
with the same patient-level bootstrap as Table 2 (train.yaml bootstrap_metric_ci, BOOTSTRAP_SEED).
Usage: uv run --group train python scripts/displayed_tiers.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "ml"))

from novarion_ml.evaluate.metrics import confidence_table
from novarion_ml.train.config import default_train_config

TARGETS = ("cad", "lad", "lcx", "rca")


def main() -> None:
    registry = json.loads((ROOT / "registry" / "models.json").read_text(encoding="utf-8"))
    entry = next(m for m in registry["models"] if m["version"] == registry["production_version"])
    patients = sorted((ROOT / entry["path"] / "demo_bundle" / "patients").glob("ZAS-*.json"))
    docs = [json.loads(p.read_text(encoding="utf-8")) for p in patients]
    train = default_train_config()
    boot = train.raw["bootstrap_metric_ci"]
    out = {"model_version": entry["version"], "n_patients": len(docs),
           "scope": "served OOF analyses (prespecified repeat) after every display gate; patient-level bootstrap",
           "targets": {}}
    for t in TARGETS:
        preds = [d["bundle"]["targets"][t] for d in docs]
        y = [d["ground_truth"][t] for d in docs]
        prob = [p["probability"] for p in preds]
        pred = [int(p["predicted_class"] == "positive") for p in preds]
        shown = [p["model_confidence_region"] if p["model_confidence"] == "high" else "low_confidence" for p in preds]
        table = confidence_table(y, prob, pred, shown, boot["replicates"], boot["min_valid"],
                                 seed=train.seeds["BOOTSTRAP_SEED"])
        reasons: dict[str, int] = {}
        for p in preds:
            for r in p["model_confidence_reasons"]:
                reasons[r] = reasons.get(r, 0) + 1
        out["targets"][t] = {**table, "low_reasons": reasons}
    (ROOT / "results" / "displayed_tiers.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
    for t, r in out["targets"].items():
        print(f"{t}: HIGH+ {r['pct_high_positive']:.1%} (PPV {r['ppv']}), HIGH- {r['pct_high_negative']:.1%}, "
              f"LOW {r['pct_low_confidence']:.1%}")


if __name__ == "__main__":
    main()
