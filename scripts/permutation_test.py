"""Label-permutation test (plan Tier 3: "200–1000 label shuffles") → results/permutation.json.

Statistic: stratified 5-fold cross-validated ROC-AUC of each target's DEPLOYED configuration (results/final, fixed
hyperparameters; AUC is unchanged by the monotone Platt step, so raw margins are used). Null: the same statistic
with the 303 labels shuffled (fixed folds, seeded shuffles). p = (1 + #{null ≥ observed}) / (1 + B) (Ojala &
Garriga 2010). Conditional on the selected configuration: the selection itself is not repeated under the null.
Wording rule: "p-value under the label-permutation null; evidence against the null under the test assumptions".
Usage: uv run --group train python scripts/permutation_test.py [--b 1000]
"""

from __future__ import annotations

import os

os.environ.setdefault("OMP_NUM_THREADS", "1")

import json
import sys
import time
import warnings
from pathlib import Path

import joblib
import numpy as np
from sklearn.metrics import roc_auc_score

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "ml"))

from novarion_ml.data.load import build_targets, build_X, load_source
from novarion_ml.train.config import default_train_config, derive_seed
from novarion_ml.train.models import CandidateModel
from novarion_ml.train.splits import stratified

TARGETS = ("cad", "lad", "lcx", "rca")
PERMUTATION_SEED = 20261012


def cv_auc(target: str, X, y: np.ndarray, config, train, folds) -> float:
    aucs = []
    for i, (tr, va) in enumerate(folds):
        model = CandidateModel(config, train, derive_seed(train.seeds["TRAIN_SEED"], target, "perm", i))
        model.fit(X.iloc[tr], y[tr])
        if 0 < y[va].sum() < len(va):
            aucs.append(roc_auc_score(y[va], model.margin(X.iloc[va])))
    return float(np.mean(aucs))


def _task(target: str, bs: list[int]) -> list[tuple[int, float]]:
    """A chunk of replicates (data loaded once per chunk). b = 0 is the observed statistic; b ≥ 1 are shuffles."""
    warnings.filterwarnings("ignore")
    train = default_train_config()
    source = load_source()
    X, Y = build_X(source), build_targets(source)
    y = Y[target].to_numpy()
    config = train.by_id()[json.loads((ROOT / "results" / "final" / f"{target}.json").read_text())["selected"]]
    folds = stratified(y, 5, derive_seed(train.seeds["SPLIT_SEED"], target, "permutation"))
    out = []
    for b in bs:
        yb = np.random.default_rng(derive_seed(PERMUTATION_SEED, target, b)).permutation(y) if b else y
        out.append((b, cv_auc(target, X, yb, config, train, folds)))
    return out


def main() -> None:
    n_perm = int(sys.argv[sys.argv.index("--b") + 1]) if "--b" in sys.argv else 1000
    t0 = time.perf_counter()
    out: dict = {"method": "5-fold CV ROC-AUC of the deployed configuration vs label-permutation null "
                           "(fixed folds; selection not repeated)", "permutations": n_perm,
                 "wording": "p-value under the label-permutation null; evidence against the null under the test assumptions",
                 "targets": {}}
    for t in TARGETS:
        chunks = [list(range(i, min(i + 50, n_perm + 1))) for i in range(0, n_perm + 1, 50)]
        res = dict(r for part in joblib.Parallel(n_jobs=max(1, (os.cpu_count() or 2) - 1))(
            joblib.delayed(_task)(t, c) for c in chunks) for r in part)
        observed, null = res[0], np.array([res[b] for b in range(1, n_perm + 1)])
        p = (1 + int((null >= observed).sum())) / (1 + n_perm)
        out["targets"][t] = {"config_id": json.loads((ROOT / "results" / "final" / f"{t}.json").read_text())["selected"],
                             "observed_cv_auc": observed, "null_mean": float(null.mean()), "null_sd": float(null.std(ddof=1)),
                             "null_p99": float(np.percentile(null, 99)), "null_max": float(null.max()), "p_value": p}
        print(f"{t}: CV AUC {observed:.3f} vs null {null.mean():.3f} ± {null.std(ddof=1):.3f} (max {null.max():.3f}); "
              f"p = {p:.4f}", flush=True)
    out["runtime_seconds"] = round(time.perf_counter() - t0, 1)
    (ROOT / "results" / "permutation.json").write_text(json.dumps(out, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
