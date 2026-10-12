"""Training orchestrator (plan §6.4, §6.10b): nested CV (parallel, cached) → evaluation tables → final models.

  uv run --group train python scripts/train.py nested     # 4 targets × 25 outer folds, cached per fold
  uv run --group train python scripts/train.py evaluate   # Table 1, Table 2, leaderboard (from the cached folds)
  uv run --group train python scripts/train.py final      # deployed model per target (CV-select on all 303 → refit)
  uv run --group train python scripts/train.py all

Parallel across (target, fold) with one thread per fit (deterministic). Outputs go to results/ (never hand-edited).
"""

from __future__ import annotations

import os

for _var in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_var, "1")  # determinism: single-threaded BLAS inside every fit
os.environ.setdefault("PYTHONHASHSEED", "0")

import csv
import hashlib
import json
import sys
import time
import warnings
from pathlib import Path

import joblib
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "ml"))

from novarion_ml.data.load import build_targets, build_X, load_source
from novarion_ml.data.registry import CONFIG_DIR, load_targets
from novarion_ml.evaluate.figures import reliability, roc_pr, threshold_sweep
from novarion_ml.evaluate.metrics import (
    baseline_metrics,
    confidence_table,
    fold_metrics,
    summarize,
)
from novarion_ml.hashing import text_sha256
from novarion_ml.train.config import default_train_config
from novarion_ml.train.nested import run_final, run_outer_fold
from novarion_ml.train.splits import outer_folds, split_manifest

RESULTS = ROOT / "results"
NESTED = RESULTS / "nested"
FINAL = RESULTS / "final"
TARGETS = ("cad", "lad", "lcx", "rca")
N_JOBS = max(1, (os.cpu_count() or 2) - 1)


def cache_key() -> str:
    parts = [default_train_config().sha256]  # code changes need an explicit rerun (D-019)
    for name in ("feature_registry.yaml", "targets.yaml", "data_source.json"):
        parts.append(text_sha256(CONFIG_DIR / name))
    return hashlib.sha256("|".join(parts).encode()).hexdigest()


def validate_fold_record(record: dict, fold, target: str, key: str, labels) -> None:
    """Reject stale or misidentified results before stamping an evaluation with current provenance."""
    expected = {"target": target, "repeat": fold.repeat, "fold": fold.fold, "cache_key": key,
                "train_ids": [int(i) for i in fold.train_ids], "test_ids": [int(i) for i in fold.test_ids],
                "y_test": [int(v) for v in labels.loc[fold.test_ids]]}
    for field, value in expected.items():
        if record.get(field) != value:
            raise ValueError(f"Stale or incompatible {target} r{fold.repeat}f{fold.fold}: {field} mismatch. "
                             "Rerun scripts/train.py nested before evaluation or bundle assembly.")
    n = len(fold.test_ids)
    for field in ("prob", "margin", "cal_logit", "pred", "region"):
        if len(record.get("test", {}).get(field, [])) != n:
            raise ValueError(f"Incomplete {target} r{fold.repeat}f{fold.fold}: test.{field} length mismatch.")


def load_data():
    source = load_source()
    return build_X(source), build_targets(source)


def _fold_path(target: str, repeat: int, fold: int) -> Path:
    return NESTED / target / f"r{repeat}f{fold}.json"


def _task(target, repeat, fold, train_ids, test_ids, key):
    warnings.filterwarnings("ignore")
    X, Y = load_data()
    train = default_train_config()
    keep = repeat == train.evaluation_repeat
    t0 = time.perf_counter()
    out = run_outer_fold(target, repeat, fold, train_ids, test_ids, X, Y[target], train,
                         load_targets()["confidence"], keep_model=keep)
    out["seconds"] = time.perf_counter() - t0
    out["cache_key"] = key
    if keep:
        (NESTED / "models").mkdir(parents=True, exist_ok=True)
        joblib.dump(out.pop("model"), NESTED / "models" / f"{target}_r{repeat}_f{fold}.joblib")
    path = _fold_path(target, repeat, fold)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out), encoding="utf-8")
    return target, repeat, fold, out["seconds"]


def all_folds(X, Y):
    train = default_train_config()
    return {t: outer_folds(t, X.index.to_numpy(), Y[t].to_numpy(), train) for t in TARGETS}


def nested() -> None:
    X, Y = load_data()
    train = default_train_config()
    folds = all_folds(X, Y)
    RESULTS.mkdir(exist_ok=True)
    (RESULTS / "split_manifest.json").write_text(json.dumps(split_manifest(folds, train), indent=1), encoding="utf-8")
    key = cache_key()
    todo = []
    for t in TARGETS:
        for f in folds[t]:
            path = _fold_path(t, f.repeat, f.fold)
            model_ok = f.repeat != train.evaluation_repeat or (NESTED / "models" / f"{t}_r{f.repeat}_f{f.fold}.joblib").exists()
            if path.exists() and json.loads(path.read_text(encoding="utf-8")).get("cache_key") == key and model_ok:
                continue
            todo.append((t, f.repeat, f.fold, f.train_ids, f.test_ids, key))
    # evaluation-repeat folds first: they feed the OOF bundle and Table 2
    todo.sort(key=lambda x: (x[1] != train.evaluation_repeat, x[1], x[0], x[2]))
    print(f"nested CV: {len(todo)} fold tasks to run on {N_JOBS} workers (cached: {4 * len(folds['cad']) - len(todo)})",
          flush=True)
    start = time.perf_counter()
    results = joblib.Parallel(n_jobs=N_JOBS, return_as="generator_unordered")(joblib.delayed(_task)(*a) for a in todo)
    for done, (t, r, f, secs) in enumerate(results, start=1):
        print(f"  [{done}/{len(todo)}] {t} r{r}f{f} {secs:.0f}s (elapsed {time.perf_counter() - start:.0f}s)", flush=True)


def _final_task(target, key):
    warnings.filterwarnings("ignore")
    X, Y = load_data()
    t0 = time.perf_counter()
    out = run_final(target, X, Y[target], default_train_config(), load_targets()["confidence"])
    FINAL.mkdir(parents=True, exist_ok=True)
    joblib.dump({"model": out["model"], "platt": out["platt"], "thresholds": out["thresholds"],
                 "oof_cal_prob": out["oof_cal_prob"]}, FINAL / f"{target}.joblib")
    summary = {k: v for k, v in out.items() if k not in ("model", "platt", "thresholds", "oof_cal_prob")}
    summary.update(platt=out["platt"].to_json(), thresholds=out["thresholds"].to_json(), cache_key=key,
                   seconds=time.perf_counter() - t0)
    (FINAL / f"{target}.json").write_text(json.dumps(summary, indent=1), encoding="utf-8")
    return target, summary["selected"], summary["seconds"]


def final() -> None:
    key = cache_key()
    todo = [t for t in TARGETS if not ((FINAL / f"{t}.json").exists() and (FINAL / f"{t}.joblib").exists()
                                       and json.loads((FINAL / f"{t}.json").read_text()).get("cache_key") == key)]
    print(f"final models: {todo}", flush=True)
    for t, selected, secs in joblib.Parallel(n_jobs=min(N_JOBS, len(todo) or 1))(
        joblib.delayed(_final_task)(t, key) for t in todo
    ):
        print(f"  {t}: {selected} ({secs:.0f}s)", flush=True)


def _deployed_thresholds(target: str) -> dict | None:
    path = FINAL / f"{target}.json"
    if not path.exists():
        return None
    thr = json.loads(path.read_text(encoding="utf-8"))["thresholds"]
    return {k: thr[k] for k in ("t_op", "t_neg", "t_pos")}


def evaluate() -> None:
    train = default_train_config()
    X, Y = load_data()
    folds = all_folds(X, Y)
    report: dict = {"train_config_sha256": train.sha256, "cache_key": cache_key(), "targets": {}}
    rows = []
    key = cache_key()
    for t in TARGETS:
        records = [json.loads(_fold_path(t, f.repeat, f.fold).read_text(encoding="utf-8")) for f in folds[t]]
        for record, fold in zip(records, folds[t], strict=True):
            validate_fold_record(record, fold, t, key, Y[t])
        model_folds, base_folds = [], {"always_negative": [], "always_positive": [], "prior": []}
        bench_folds: dict[str, list] = {fam: [] for fam in train.raw["family_order"]}
        for rec in records:
            y = np.array(rec["y_test"])
            s = rec["test"]
            model_folds.append(fold_metrics(y, s["prob"], s["cal_logit"], s["pred"]))
            train_prev = float(Y[t].loc[rec["train_ids"]].mean())
            for name, m in baseline_metrics(y, train_prev).items():
                base_folds[name].append(m)
            for fam, b in rec["benchmarks"].items():
                if "test" in b:
                    bs = b["test"]
                    bench_folds[fam].append(fold_metrics(y, bs["prob"], bs["cal_logit"], bs["pred"]))
        ev = [r for r in records if r["repeat"] == train.evaluation_repeat]
        y_ev = np.concatenate([r["y_test"] for r in ev])
        cat = {k: np.concatenate([r["test"][k] for r in ev]) for k in ("prob", "pred")}
        regions = [x for r in ev for x in r["test"]["region"]]
        boot = train.raw["bootstrap_metric_ci"]
        table2 = confidence_table(y_ev, cat["prob"], cat["pred"], regions, boot["replicates"], boot["min_valid"],
                                  seed=train.seeds["BOOTSTRAP_SEED"])
        families: dict[str, int] = {}
        for rec in records:
            families[rec["family"]] = families.get(rec["family"], 0) + 1
        report["targets"][t] = {
            "prevalence": float(Y[t].mean()), "n": len(Y[t]),
            "table1_scope": "outer-fold mean ± SD (25 folds)",
            "model": summarize(model_folds),
            "baselines": {k: summarize(v, list(v[0].keys()) if v else []) for k, v in base_folds.items()},
            "benchmarks": {fam: summarize(v) for fam, v in bench_folds.items() if v},
            "table2_scope": "pooled OOF (prespecified repeat), threshold-only before app input-quality gates",
            "table2": table2,
            "selected_families": families,
            "calibration_guard_events": sum(len(r["guard_log"]) for r in records),
            "folds_without_high_positive_region": sum(r["thresholds"]["t_pos"] is None for r in records),
            "folds_without_high_negative_region": sum(r["thresholds"]["t_neg"] is None for r in records),
            "figures": {
                "scope": "pooled OOF (prespecified repeat); bands = patient-level bootstrap 95%",
                **roc_pr(y_ev, cat["prob"], 1000, train.seeds["BOOTSTRAP_SEED"]),
                "reliability": reliability(y_ev, cat["prob"], 5, 1000, train.seeds["BOOTSTRAP_SEED"]),
                "threshold_sweep": threshold_sweep(y_ev, cat["prob"]),
                "deployed_thresholds": _deployed_thresholds(t),
            },
        }
        for name, summary in [("selected (nested CV)", report["targets"][t]["model"])] + [
            (f"benchmark: {fam}", s) for fam, s in report["targets"][t]["benchmarks"].items()
        ] + [(f"baseline: {k}", s) for k, s in report["targets"][t]["baselines"].items()]:
            row = {"target": t, "model": name}
            for m in ("roc_auc", "pr_auc", "accuracy", "balanced_accuracy", "precision", "recall", "f1",
                      "specificity", "npv", "brier", "cal_slope", "cal_intercept"):
                v = summary.get(m)
                row[m] = "" if not v or v["mean"] is None else f"{v['mean']:.3f} ± {v['sd'] or 0:.3f}"
            rows.append(row)
    (RESULTS / "metrics.json").write_text(json.dumps(report, indent=1), encoding="utf-8")
    with open(RESULTS / "leaderboard.csv", "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)
    for t in TARGETS:
        m = report["targets"][t]
        auc, t2 = m["model"]["roc_auc"], m["table2"]
        print(f"{t}: AUC {auc['mean']:.3f} ± {auc['sd']:.3f} | prevalence {m['prevalence']:.3f} | "
              f"HIGH+ {t2['pct_high_positive']:.0%} HIGH- {t2['pct_high_negative']:.0%} LOW {t2['pct_low_confidence']:.0%} | "
              f"families {m['selected_families']}")


if __name__ == "__main__":
    step = sys.argv[1] if len(sys.argv) > 1 else "all"
    if step in ("nested", "all"):
        nested()
    if step in ("final", "all"):
        final()
    if step in ("evaluate", "all"):
        evaluate()
