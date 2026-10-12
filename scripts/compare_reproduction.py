"""Compare a reproduction (fresh clone / second machine) with this checkout (plan Days 18–19 "full training
reproduction, artifact verification").

Checks, with the tolerances that matter for each:
  - split manifest hash and every outer fold's train/test ids: exact
  - selected configuration per outer fold and per deployed model: exact
  - Table 1 / Table 2 metrics (results/metrics.json): |Δ| ≤ 1e-9
  - golden predictions of the production bundle (24 fixed inputs × 4 targets): |Δp| ≤ 1e-6, classes exact
  - stability intervals (results/stability.json) and replay study (registry/replay.json): |Δ| ≤ 1e-9
  - the reproduction's stored training-side OOF scores vs results/fold_ledger_oof.json (D-019 recomputation)
Usage: uv run python scripts/compare_reproduction.py --other PATH_TO_OTHER_CHECKOUT
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "ml"))

from novarion_ml.hashing import text_sha256

ROOT = Path(__file__).resolve().parents[1]
TARGETS = ("cad", "lad", "lcx", "rca")
# Config-derived hashes: older runs hashed raw bytes, so a CRLF checkout changed them (fixed in D-020). They are
# verified through "config files identical modulo line endings" instead of byte equality.
CONFIG_HASH_KEYS = {"train_config_sha256", "replay_config_sha256", "promotion_gate_sha256", "split_manifest_sha256"}


def load(base: Path, rel: str):
    return json.loads((base / rel).read_text(encoding="utf-8"))


def max_numeric_diff(a, b, path: str = "") -> tuple[float, list[str]]:
    """Largest |a − b| over matching numbers; structural differences are listed."""
    if isinstance(a, dict) and isinstance(b, dict):
        worst, issues = 0.0, []
        for k in sorted(set(a) | set(b)):
            if k in {"seconds", "runtime_seconds", "fit_seconds_total", "created_at", "measured_at", "cache_key",
                     "table2_scope"} | CONFIG_HASH_KEYS:  # wording label (D-019) / config hashes (checked separately)
                continue
            if k not in a or k not in b:
                issues.append(f"{path}/{k}: missing on one side")
                continue
            w, i = max_numeric_diff(a[k], b[k], f"{path}/{k}")
            worst, issues = max(worst, w), issues + i
        return worst, issues
    if isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            return 0.0, [f"{path}: length {len(a)} vs {len(b)}"]
        worst, issues = 0.0, []
        for j, (x, y) in enumerate(zip(a, b, strict=True)):
            w, i = max_numeric_diff(x, y, f"{path}[{j}]")
            worst, issues = max(worst, w), issues + i
        return worst, issues
    if isinstance(a, bool) or isinstance(b, bool) or not isinstance(a, int | float) or not isinstance(b, int | float):
        return 0.0, ([] if a == b else [f"{path}: {a!r} vs {b!r}"])
    if a is None or b is None or (math.isnan(a) and math.isnan(b)):
        return 0.0, []
    return abs(a - b), []


def production_dir(base: Path) -> Path:
    registry = load(base, "registry/models.json")
    entry = next(m for m in registry["models"] if m["version"] == registry["production_version"])
    return base / entry["path"]


def main() -> int:
    other = Path(sys.argv[sys.argv.index("--other") + 1]).resolve()
    report, ok = {}, True

    def check(name: str, passed: bool, detail: str) -> None:
        nonlocal ok
        ok &= passed
        report[name] = {"pass": passed, "detail": detail}
        print(f"[{'PASS' if passed else 'FAIL'}] {name}: {detail}")

    configs = sorted(p.name for p in (ROOT / "config").iterdir() if p.suffix in {".yaml", ".json"})
    differing = [n for n in configs if text_sha256(ROOT / "config" / n) != text_sha256(other / "config" / n)]
    check("config files (identical modulo line endings)", not differing, f"{len(configs)} files; differing {differing}")
    a, b = load(ROOT, "results/split_manifest.json"), load(other, "results/split_manifest.json")
    w, issues = max_numeric_diff(a, b)
    check("split manifest (every outer fold)", not issues, f"{a['split_manifest_sha256'][:16]}; {issues[:3]}")
    diffs = []
    for t in TARGETS:
        for f in sorted((ROOT / "results" / "nested" / t).glob("r*f*.json")):
            x, y = load(ROOT, f"results/nested/{t}/{f.name}"), load(other, f"results/nested/{t}/{f.name}")
            if (x["train_ids"], x["test_ids"], x["selected"]) != (y["train_ids"], y["test_ids"], y["selected"]):
                diffs.append(f"{t}/{f.stem}")
    check("outer folds + selected configs", not diffs, f"{len(diffs)} differing fold records {diffs[:5]}")
    finals = {t: (load(ROOT, f"results/final/{t}.json")["selected"], load(other, f"results/final/{t}.json")["selected"])
              for t in TARGETS}
    check("deployed configurations", all(x == y for x, y in finals.values()), str({t: x for t, (x, _) in finals.items()}))
    w, issues = max_numeric_diff(load(ROOT, "results/metrics.json"), load(other, "results/metrics.json"))
    check("metrics (Tables 1-2)", w <= 1e-9 and not issues, f"max |diff| {w:.2e}; {issues[:3]}")
    ga = load(production_dir(ROOT), "golden/golden_predictions.json")["cases"]
    gb = load(production_dir(other), "golden/golden_predictions.json")["cases"]
    worst, classes = 0.0, True
    for x, y in zip(ga, gb, strict=True):
        for t in TARGETS:
            worst = max(worst, abs(x["targets"][t]["probability"] - y["targets"][t]["probability"]))
            classes &= x["targets"][t]["predicted_class"] == y["targets"][t]["predicted_class"]
    check("golden predictions", worst <= 1e-6 and classes, f"max |dp| {worst:.2e}; classes identical: {classes}")
    for rel in ("results/stability.json", "registry/replay.json"):
        if (other / rel).exists():
            w, issues = max_numeric_diff(load(ROOT, rel), load(other, rel))
            check(rel, w <= 1e-9 and not issues, f"max |diff| {w:.2e}; {issues[:3]}")
    if (ROOT / "results/fold_ledger_oof.json").exists():
        rec = load(ROOT, "results/fold_ledger_oof.json")["folds"]
        worst = 0.0
        for key, v in rec.items():
            t, k = key.split(":")
            y = load(other, f"results/nested/{t}/r0f{k}.json").get("training_oof_prob")
            if y is None:
                worst = math.inf
                break
            worst = max(worst, max(abs(p - q) for p, q in zip(v["training_oof_prob"], y, strict=True)))
        check("D-019 recomputed fold scores vs a real retrain", worst <= 1e-9, f"max |diff| {worst:.2e}")
    (ROOT / "results" / "reproduction.json").write_text(json.dumps({"other": other.name, "pass": ok, "checks": report},
                                                                    indent=1), encoding="utf-8")
    print("REPRODUCED" if ok else "DIFFERENCES FOUND")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
