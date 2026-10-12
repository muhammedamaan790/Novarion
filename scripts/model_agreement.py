"""Model agreement (plan Tier 3: "spread of candidate-family probabilities · robustness cue") → results/model_agreement.json.

For every dataset patient in the prespecified evaluation repeat, the outer fold that held them out also produced a
calibrated probability and class from each candidate family (LR, EBM, XGBoost, CatBoost; same selection rule
within the family — the Table 3 benchmarks). This reports, per target: how often all four families agree on the
class, the spread of their probabilities, and whether disagreement marks harder patients (error rate of the
selected model when the families agree vs disagree). Descriptive only; no model is changed.
Usage: uv run --group train python scripts/model_agreement.py
"""

from __future__ import annotations

import json
import sys
from itertools import combinations
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "ml"))

from novarion_ml.data.load import patient_id
from novarion_ml.train.config import default_train_config

TARGETS = ("cad", "lad", "lcx", "rca")
FAMILIES = ("lr", "ebm", "xgboost", "catboost")


def main() -> None:
    train = default_train_config()
    out: dict = {"scope": "pooled OOF, prespecified evaluation repeat; families = Table 3 benchmarks", "targets": {}}
    for t in TARGETS:
        probs, preds, sel_pred, y, ids = [], [], [], [], []
        for k in range(train.outer_k):
            rec = json.loads((ROOT / "results" / "nested" / t / f"r{train.evaluation_repeat}f{k}.json").read_text())
            bench = rec["benchmarks"]
            usable = [f for f in FAMILIES if "test" in bench.get(f, {})]
            if len(usable) != len(FAMILIES):
                raise SystemExit(f"{t} k{k + 1}: a family benchmark is missing ({usable})")
            probs.append(np.column_stack([bench[f]["test"]["prob"] for f in FAMILIES]))
            preds.append(np.column_stack([bench[f]["test"]["pred"] for f in FAMILIES]))
            sel_pred.append(np.asarray(rec["test"]["pred"]))
            y.append(np.asarray(rec["y_test"]))
            ids += rec["test_ids"]
        P, C, S, Y = np.vstack(probs), np.vstack(preds), np.concatenate(sel_pred), np.concatenate(y)
        agree = (C == C[:, :1]).all(axis=1)
        spread = P.max(axis=1) - P.min(axis=1)
        err = S != Y
        pairwise = {f"{FAMILIES[a]}~{FAMILIES[b]}": float((C[:, a] == C[:, b]).mean())
                    for a, b in combinations(range(len(FAMILIES)), 2)}
        out["targets"][t] = {
            "n": len(Y), "all_four_agree": float(agree.mean()),
            "probability_range_median": float(np.median(spread)), "probability_range_p90": float(np.percentile(spread, 90)),
            "selected_error_rate_when_agree": float(err[agree].mean()) if agree.any() else None,
            "selected_error_rate_when_disagree": float(err[~agree].mean()) if (~agree).any() else None,
            "n_agree": int(agree.sum()), "n_disagree": int((~agree).sum()), "pairwise_class_agreement": pairwise,
            "patients": {patient_id(int(i)): {"probabilities": dict(zip(FAMILIES, map(float, P[j]), strict=True)),
                                              "classes_agree": bool(agree[j])} for j, i in enumerate(ids)},
        }
        r = out["targets"][t]
        print(f"{t}: all 4 agree {r['all_four_agree']:.0%} | median prob range {r['probability_range_median']:.2f} | "
              f"selected-model error {r['selected_error_rate_when_agree']:.0%} when agree vs "
              f"{r['selected_error_rate_when_disagree']:.0%} when disagree")
    (ROOT / "results" / "model_agreement.json").write_text(json.dumps(out, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
