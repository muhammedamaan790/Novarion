"""Historical replay of the governed update process (plan §12B, §11A "Exact replay algorithm"; config/replay.yaml).

Per seed: a seeded random arrival order splits the 303 patients into I (153) + B1, B2, B3 (50 each).
  M0 ← procedure(I)              LC point 1 = M0 on B1    (training size 153)
  C1 ← procedure(I ∪ B1)         gate 1: champion (M0) vs C1, both scored ONCE on B2;  LC point 2 = C1 on B2
  C2 ← procedure(I ∪ B1 ∪ B2)    gate 2: champion vs C2 on B3;                        LC point 3 = C2 on B3
On PASS the champion becomes the challenger: refit(frozen C_s config, same data) is C_s itself here, because the
procedure already ends with that exact refit on the same rows. No model is ever scored on rows it trained on.
Replay models never leave results/replay/ and can never become production.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np
import yaml
from sklearn.metrics import roc_auc_score

from ..data.registry import CONFIG_DIR
from ..train.config import derive_seed
from .gate import gate_status, gate_target

REPLAY_YAML = CONFIG_DIR / "replay.yaml"
TARGETS = ("cad", "lad", "lcx", "rca")


def load_replay(path: Path = REPLAY_YAML) -> dict[str, Any]:
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def partition(ids: list[int], seed_index: int, cfg: dict[str, Any]) -> tuple[list[int], list[list[int]]]:
    rng = np.random.default_rng(derive_seed(cfg["REPLAY_SEED"], "replay", seed_index))
    order = [int(i) for i in rng.permutation(sorted(ids))]
    n0 = cfg["partition"]["initial"]
    initial, batches, start = order[:n0], [], n0
    for size in cfg["partition"]["batches"]:
        batches.append(order[start:start + size])
        start += size
    assert start == len(ids) == len(set(initial) | {i for b in batches for i in b}), "replay partition must be exact"
    return initial, batches


def training_ids(initial: list[int], batches: list[list[int]], step: int) -> list[int]:
    """Rows model `step` trains on: I ∪ B1 ∪ … ∪ B_step."""
    return [*initial, *(i for b in batches[:step] for i in b)]


def _metrics(y: np.ndarray, p: np.ndarray) -> dict[str, float | None]:
    auc = float(roc_auc_score(y, p)) if 0 < y.sum() < len(y) else None
    return {"auc": auc, "brier": float(np.mean((p - y) ** 2))}


def run_gates(seed_index: int, scores: dict[tuple[str, int], dict[int, dict[str, Any]]],
              gate: dict[str, Any]) -> dict[str, Any]:
    """Sequential champion/challenger logic for one seed. scores[(target, step)][batch] = {y, p, logit} where model
    `step` (trained on I ∪ B1..B_step) is scored on every later batch index `batch` (0-based: B1 = 0)."""
    n_batches = 1 + max(b for per in scores.values() for b in per)
    curve = {t: [{"training_step": s, **_metrics(np.array(scores[(t, s)][s]["y"]), np.array(scores[(t, s)][s]["p"]))}
                 for s in range(n_batches)] for t in TARGETS}
    champion, gates = 0, []
    for s in range(1, n_batches):  # gate s: champion vs challenger C_s, scored on batch B_{s+1}
        results = {}
        for t in TARGETS:
            ch, pr = scores[(t, s)][s], scores[(t, champion)][s]
            assert ch["y"] == pr["y"], "paired: same holdout patients for both models"
            results[t] = gate_target(t, np.array(ch["y"]), np.array(pr["p"]), np.array(ch["p"]), np.array(ch["logit"]),
                                     gate, derive_seed(gate["bootstrap"]["seed"], "replay", seed_index, s, t))
        status = gate_status(results)
        gates.append({"gate": s, "champion_step": champion, "challenger_step": s, "holdout_batch": s + 1,
                      "status": status, "promoted": status == "PASS", "targets": results})
        if status == "PASS":
            champion = s
    return {"seed": seed_index, "learning_curve": curve, "gates": gates, "final_champion_step": champion}


def summarize(seeds: list[dict[str, Any]], sizes: list[int]) -> dict[str, Any]:
    curve = {}
    for t in TARGETS:
        points = []
        for s, size in enumerate(sizes):
            aucs = [r["learning_curve"][t][s]["auc"] for r in seeds if r["learning_curve"][t][s]["auc"] is not None]
            briers = [r["learning_curve"][t][s]["brier"] for r in seeds]
            points.append({"training_size": size, "n_seeds": len(aucs),
                           "auc_mean": float(np.mean(aucs)), "auc_sd": float(np.std(aucs, ddof=1)),
                           "auc_min": float(np.min(aucs)), "auc_max": float(np.max(aucs)),
                           "brier_mean": float(np.mean(briers)), "brier_sd": float(np.std(briers, ddof=1))})
        curve[t] = points
    freq: dict[str, dict[str, int]] = {}
    for r in seeds:
        for g in r["gates"]:
            freq.setdefault(f"gate {g['gate']}", {"PASS": 0, "FAIL": 0, "INSUFFICIENT_EVIDENCE": 0})[g["status"]] += 1
    return {"learning_curve": curve, "gate_frequencies": freq}
