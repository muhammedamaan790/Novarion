"""Feature-group ablation (plan §7 "ablation heatmap: target × feature group removed"). DESCRIPTIVE ONLY.

For each target and each presentation group: drop that group's features, then re-run the training-side procedure on
the SAME 25 outer folds (inner-CV 1-SE selection → Platt on cross-fitted margins → refit → outer test once), and
report the outer-fold ROC-AUC change vs the full feature set run the same way.

Scope (stated in every output): the procedure is restricted to the logistic-regression family of the pre-registered
grid (16 configurations: penalty × C × class_weight, feature set = full minus the group). LR was selected in 79/100
outer folds of the main nested CV; restricting keeps 6 variants × 4 targets × 25 folds tractable (minutes, not hours).
Nothing here changes the deployed model. Usage: uv run --group train python scripts/ablation.py
"""

from __future__ import annotations

import os

os.environ.setdefault("OMP_NUM_THREADS", "1")

import json
import sys
import warnings
from dataclasses import replace
from pathlib import Path

import joblib
import numpy as np
from sklearn.metrics import roc_auc_score

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "ml"))

from novarion_ml.data.load import build_targets, build_X, load_source
from novarion_ml.train.config import (
    default_train_config,
    derive_seed,
)
from novarion_ml.train.models import CandidateModel
from novarion_ml.train.nested import inner_cv, select
from novarion_ml.train.splits import outer_folds

TARGETS = ("cad", "lad", "lcx", "rca")
GROUPS = ("demographics", "history", "symptoms_exam", "ecg", "labs", "echo")
OUT = ROOT / "results" / "ablation.json"


def _task(target: str, variant: str, fold_index: int) -> tuple[str, str, int, float]:
    """Training-side procedure on one outer fold for one feature-set variant; returns the outer-test AUC."""
    warnings.filterwarnings("ignore")
    source = load_source()
    X, Y = build_X(source), build_targets(source)
    y = Y[target]
    train = default_train_config()
    fold = outer_folds(target, X.index.to_numpy(), y.to_numpy(), train)[fold_index]
    feature_set = "full" if variant == "none" else f"full_without:{variant}"
    # the 16 LR configurations of the grid (penalty × C × class_weight), on the variant's feature set
    configs = tuple(replace(c, feature_set=feature_set) for c in train.configs
                    if c.family == "lr" and c.feature_set == "full")
    f_tr, f_te = X.loc[fold.train_ids], X.loc[fold.test_ids]
    y_tr, y_te = y.loc[fold.train_ids].to_numpy(), y.loc[fold.test_ids].to_numpy()
    results = inner_cv(target, f_tr, y_tr, train, configs, ("ablation", variant, fold.repeat, fold.fold))
    selection = select(results, y_tr)
    seed = derive_seed(train.seeds["TRAIN_SEED"], target, "ablation", variant, fold.repeat, fold.fold, "refit")
    model = CandidateModel(selection.config, train, seed).fit(f_tr, y_tr)
    return target, variant, fold_index, float(roc_auc_score(y_te, selection.platt.logit(model.margin(f_te))))


def main() -> None:
    train = default_train_config()
    n_folds = train.outer_k * train.repeats
    tasks = [(t, v, i) for t in TARGETS for v in ("none", *GROUPS) for i in range(n_folds)]
    print(f"ablation: {len(tasks)} fold runs (LR family)", flush=True)
    results = joblib.Parallel(n_jobs=max(1, (os.cpu_count() or 2) - 1))(joblib.delayed(_task)(*t) for t in tasks)
    aucs: dict[str, dict[str, list[float]]] = {t: {} for t in TARGETS}
    for t, v, _, auc in results:
        aucs[t].setdefault(v, []).append(auc)
    report = {"scope": "logistic-regression family of the pre-registered grid; same 25 outer folds; descriptive only",
              "metric": "outer-fold ROC-AUC (mean ± SD); delta = variant − full, paired by fold", "targets": {}}
    for t in TARGETS:
        base = np.array(aucs[t]["none"])
        rows = {"full": {"mean": float(base.mean()), "sd": float(base.std(ddof=1))}}
        for g in GROUPS:
            v = np.array(aucs[t][g])
            d = v - base
            rows[f"without_{g}"] = {"mean": float(v.mean()), "sd": float(v.std(ddof=1)),
                                    "delta_mean": float(d.mean()), "delta_sd": float(d.std(ddof=1))}
        report["targets"][t] = rows
    OUT.write_text(json.dumps(report, indent=1), encoding="utf-8")
    for t in TARGETS:
        r = report["targets"][t]
        print(t, f"full {r['full']['mean']:.3f}", " ".join(f"{g}:{r[f'without_{g}']['delta_mean']:+.3f}" for g in GROUPS))


if __name__ == "__main__":
    main()
