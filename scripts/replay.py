"""Run the historical replay study (plan §12B, §11A; config/replay.yaml) → results/replay.json.

Every (seed, target, step) final-model procedure run is independent of the gate decisions, so all of them run in
parallel first; the sequential champion/challenger gates then run per seed on the stored holdout scores.
Usage: uv run --group train python scripts/replay.py [--seeds N]   (N < replay.yaml seeds only for smoke tests)
"""

from __future__ import annotations

import os

os.environ.setdefault("OMP_NUM_THREADS", "1")

import hashlib
import json
import sys
import time
import warnings
from pathlib import Path

import joblib

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "ml"))

from novarion_ml.data.load import build_targets, build_X, load_source
from novarion_ml.lifecycle.gate import GATE_YAML, load_gate
from novarion_ml.lifecycle.procedure import procedure, restrict, score
from novarion_ml.lifecycle.replay import (
    REPLAY_YAML,
    TARGETS,
    load_replay,
    partition,
    run_gates,
    summarize,
    training_ids,
)
from novarion_ml.train.config import default_train_config


def _job(seed_index: int, target: str, step: int) -> dict:
    warnings.filterwarnings("ignore")
    cfg = load_replay()
    train = restrict(default_train_config(), cfg["families"])
    source = load_source()
    X, Y = build_X(source), build_targets(source)
    initial, batches = partition([int(i) for i in X.index], seed_index, cfg)
    rows = training_ids(initial, batches, step)
    t0 = time.perf_counter()
    fitted = procedure(target, X.loc[rows], Y[target], train)
    held = set(rows)
    scores = {}
    for b in range(step, len(batches)):  # only batches that arrive AFTER this model's training data
        assert not held & set(batches[b]), "a replay model is never scored on rows it trained on"
        p, logit = score(fitted, X.loc[batches[b]])
        scores[b] = {"y": [int(v) for v in Y[target].loc[batches[b]]], "p": p.tolist(), "logit": logit.tolist()}
    return {"seed": seed_index, "target": target, "step": step, "selected": fitted["selected"],
            "training_size": len(rows), "scores": scores, "seconds": time.perf_counter() - t0}


def main() -> None:
    cfg = load_replay()
    n_seeds = int(sys.argv[sys.argv.index("--seeds") + 1]) if "--seeds" in sys.argv else cfg["seeds"]
    n_steps = len(cfg["partition"]["batches"])
    jobs = [(s, t, k) for s in range(n_seeds) for t in TARGETS for k in range(n_steps)]
    print(f"replay: {n_seeds} seeds x {len(TARGETS)} targets x {n_steps} procedure runs = {len(jobs)} jobs "
          f"(families {cfg['families']})", flush=True)
    t0 = time.perf_counter()
    out = joblib.Parallel(n_jobs=max(1, (os.cpu_count() or 2) - 1), verbose=5)(joblib.delayed(_job)(*j) for j in jobs)
    gate = load_gate()
    seeds = []
    for s in range(n_seeds):
        mine = [r for r in out if r["seed"] == s]
        scores = {(r["target"], r["step"]): {int(b): v for b, v in r["scores"].items()} for r in mine}
        result = run_gates(s, scores, gate)
        result["selected"] = {f"{r['target']}:step{r['step']}": r["selected"] for r in mine}
        seeds.append(result)
    sizes = [cfg["partition"]["initial"] + sum(cfg["partition"]["batches"][:k]) for k in range(n_steps)]
    report = {
        "title": cfg["title"], "namespace": "replay (never production)",
        "replay_config_sha256": hashlib.sha256(REPLAY_YAML.read_bytes()).hexdigest(),
        "promotion_gate_sha256": hashlib.sha256(GATE_YAML.read_bytes()).hexdigest(),
        "families": cfg["families"], "seeds": n_seeds, "partition": cfg["partition"], "training_sizes": sizes,
        "scoring": "each learning-curve point = the step-s model on the NEXT arrival batch (forward holdout, n = 50)",
        **summarize(seeds, sizes), "per_seed": seeds,
        "runtime_seconds": round(time.perf_counter() - t0, 1),
        "fit_seconds_total": round(sum(r["seconds"] for r in out), 1),
    }
    suffix = "" if n_seeds == cfg["seeds"] else f"_smoke{n_seeds}"
    (ROOT / "results" / f"replay{suffix}.json").write_text(json.dumps(report, indent=1), encoding="utf-8")
    if not suffix:  # the replay namespace of the registry (served by GET /models/replay; never production)
        api = {"title": cfg["title"], "seeds": n_seeds, "families": cfg["families"], "training_sizes": sizes,
               "holdout_batch_size": cfg["partition"]["batches"][0], "learning_curve": report["learning_curve"],
               "gate_frequencies": report["gate_frequencies"], "replay_config_sha256": report["replay_config_sha256"],
               "gate_log": [{"seed": r["seed"], "gate": g["gate"], "status": g["status"], "promoted": g["promoted"],
                             "failed_rules": {t: sorted(k for k, ok in res["rules"].items() if not ok)
                                              for t, res in g["targets"].items()
                                              if res["evaluable"] and not all(res["rules"].values())}}
                            for r in seeds for g in r["gates"]]}
        (ROOT / "registry" / "replay.json").write_text(json.dumps(api, indent=1) + "\n", encoding="utf-8")
    for t in TARGETS:
        pts = " -> ".join(f"{p['training_size']}: {p['auc_mean']:.3f}+-{p['auc_sd']:.3f}" for p in report["learning_curve"][t])
        print(f"  {t}: AUC {pts}")
    print(f"  gates: {report['gate_frequencies']}  ({report['runtime_seconds']:.0f}s)")


if __name__ == "__main__":
    main()
