"""Run the stability bootstrap (plan §6.10a) for the evaluation-repeat folds of every target → results/stability.json.

Each dataset patient's interval comes from refits of the model that produced its out-of-fold prediction (fold k's
selected configuration, its outer-training rows only). Parallel over (target, fold); one thread per fit.
Usage: uv run --group train python scripts/stability.py [--replicates 100]
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

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "ml"))
sys.path.insert(0, str(ROOT))

from novarion_ml.data.load import build_targets, build_X, load_source, patient_id
from novarion_ml.train.config import default_train_config
from novarion_ml.uncertainty.stability import stability_fold

TARGETS = ("cad", "lad", "lcx", "rca")


def _task(target: str, fold: int, replicates: int) -> dict:
    warnings.filterwarnings("ignore")
    train = default_train_config()
    rec = json.loads((ROOT / "results" / "nested" / target / f"r{train.evaluation_repeat}f{fold}.json").read_text())
    source = load_source()
    X, Y = build_X(source), build_targets(source)
    config = train.by_id()[rec["selected"]]
    t0 = time.perf_counter()
    out = stability_fold(target, fold, np.array(rec["train_ids"]), np.array(rec["test_ids"]), config, X, Y[target],
                         train, replicates=replicates)
    out["t_op"] = rec["thresholds"]["t_op"]
    out["seconds"] = time.perf_counter() - t0
    return out


def main() -> None:
    replicates = int(sys.argv[sys.argv.index("--replicates") + 1]) if "--replicates" in sys.argv else 100
    train = default_train_config()
    tasks = [(t, k, replicates) for t in TARGETS for k in range(train.outer_k)]
    print(f"stability bootstrap: {len(tasks)} (target, fold) tasks x {replicates} replicates", flush=True)
    results = joblib.Parallel(n_jobs=max(1, (os.cpu_count() or 2) - 1))(joblib.delayed(_task)(*t) for t in tasks)
    from scripts.train import cache_key

    report: dict = {"method": "plan §6.10a algorithm B (OOF-safe refit bootstrap, evaluation repeat)",
                    # The fits these intervals belong to (audit R15): build_bundle refuses them for any other fits.
                    "cache_key": cache_key(),
                    "replicates": replicates, "min_valid": 80, "folds": [], "targets": {t: {} for t in TARGETS}}
    for r in results:
        crossings = 0
        for rid, interval in r["intervals"].items():
            report["targets"][r["target"]][patient_id(int(rid))] = interval
            if "p10" in interval and interval["p10"] < r["t_op"] <= interval["p90"]:
                crossings += 1
        report["folds"].append({"target": r["target"], "fold": r["fold"] + 1, "config_id": r["config_id"],
                                "valid_replicates": r["n_valid"], "seconds": round(r["seconds"], 1),
                                "intervals_crossing_t_op": crossings,
                                "invalid": [x for x in r["log"] if x["status"] != "valid"]})
        print(f"  {r['target']} k{r['fold'] + 1}: {r['n_valid']}/{replicates} valid, {crossings} intervals cross t_op "
              f"({r['seconds']:.0f}s)", flush=True)
    (ROOT / "results" / "stability.json").write_text(json.dumps(report, indent=1), encoding="utf-8")
    print("results/stability.json written")


if __name__ == "__main__":
    main()
