"""Training-side cross-fitted OOF probabilities for each evaluation-repeat outer fold → results/fold_ledger_oof.json.

The fold-safe evidence ledger (D-019, from PR #1's audit) must bin fold k's reference patients by scores that never
saw fold k's held-out patients: the inner cross-fitted margins of fold k's SELECTED configuration, calibrated with
fold k's Platt. New nested runs store these directly (`training_oof_prob`); for the frozen v1.0 fits this script
recomputes them — inner_cv seeds every fit by (target, repeat, fold, config_id, inner fold), so running only the
selected configuration reproduces them exactly. Proof: refitting Platt on the recomputed margins must give the
stored (a, b); any mismatch aborts.
Usage: uv run --group train python scripts/fold_ledger_oof.py
"""

from __future__ import annotations

import os

os.environ.setdefault("OMP_NUM_THREADS", "1")

import json
import sys
import warnings
from pathlib import Path

import joblib

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "ml"))

from novarion_ml.calibrate.platt import Platt, fit_platt
from novarion_ml.data.load import build_targets, build_X, load_source
from novarion_ml.train.config import default_train_config
from novarion_ml.train.nested import inner_cv

TARGETS = ("cad", "lad", "lcx", "rca")
TOLERANCE = 1e-6


def _task(target: str, fold: int) -> dict:
    warnings.filterwarnings("ignore")
    train = default_train_config()
    rec = json.loads((ROOT / "results" / "nested" / target / f"r{train.evaluation_repeat}f{fold}.json").read_text())
    source = load_source()
    X, Y = build_X(source), build_targets(source)
    ids = rec["train_ids"]
    y = Y[target].loc[ids].to_numpy()
    config = train.by_id()[rec["selected"]]
    (result,) = inner_cv(target, X.loc[ids], y, train, (config,), (rec["repeat"], rec["fold"]))
    refit = fit_platt(result.oof_margin, y)
    stored = rec["platt"]
    diff = max(abs(refit.a - stored["a"]), abs(refit.b - stored["b"]))
    if not diff <= TOLERANCE:
        raise RuntimeError(f"{target} k{fold + 1}: recomputed margins do not reproduce the stored Platt fit "
                           f"(max |delta| = {diff:.3g}); refusing to build a ledger from them")
    probs = Platt(stored["a"], stored["b"]).prob(result.oof_margin)
    return {"target": target, "fold": fold, "train_ids": ids, "training_oof_prob": probs.tolist(),
            "platt_reproduction_max_abs_diff": diff}


def main() -> None:
    train = default_train_config()
    tasks = [(t, k) for t in TARGETS for k in range(train.outer_k)]
    out = joblib.Parallel(n_jobs=max(1, (os.cpu_count() or 2) - 1))(joblib.delayed(_task)(*t) for t in tasks)
    doc = {"method": "inner cross-fitted margins of each fold's selected configuration, fold Platt (D-019)",
           "evaluation_repeat": train.evaluation_repeat,
           "folds": {f"{r['target']}:{r['fold']}": {k: r[k] for k in ("train_ids", "training_oof_prob",
                                                                         "platt_reproduction_max_abs_diff")}
                     for r in out}}
    (ROOT / "results" / "fold_ledger_oof.json").write_text(json.dumps(doc), encoding="utf-8")
    worst = max(r["platt_reproduction_max_abs_diff"] for r in out)
    print(f"results/fold_ledger_oof.json: {len(out)} folds, Platt reproduced to within {worst:.2e}")


if __name__ == "__main__":
    main()
