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


def golden_diff(ga: list[dict], gb: list[dict]) -> tuple[float, list[str]]:
    """Golden predictions, finite-aware like everything else (audit N09): the same cases in the same order with the same
    inputs, then every target's probability (a NaN on one side is a difference, not a dropped value) and class."""
    names_a = [(c["name"], c["input_sha256"]) for c in ga]
    names_b = [(c["name"], c["input_sha256"]) for c in gb]
    if names_a != names_b:
        return 0.0, [f"golden cases differ: {len(ga)} vs {len(gb)} cases or other names/inputs"]
    worst, issues = 0.0, []
    for x, y in zip(ga, gb, strict=True):
        for t in TARGETS:
            w, i = max_numeric_diff(x["targets"][t]["probability"], y["targets"][t]["probability"],
                                    f"{x['name']}/{t}/probability")
            worst, issues = max(worst, w), issues + i
            if x["targets"][t]["predicted_class"] != y["targets"][t]["predicted_class"]:
                issues.append(f"{x['name']}/{t}: class {x['targets'][t]['predicted_class']} vs "
                              f"{y['targets'][t]['predicted_class']}")
    return worst, issues


def ledger_diff(folds: dict[str, dict], other_fold) -> tuple[float, list[str]]:
    """D-019 recomputed fold scores against a real retrain's, finite-aware; a missing reference output is a
    difference (audit N09). `other_fold(target, k)` loads the other run's results/nested record."""
    worst, issues = 0.0, []
    for key, v in folds.items():
        t, k = key.split(":")
        y = other_fold(t, k).get("training_oof_prob")
        if y is None:
            issues.append(f"{key}: no training_oof_prob in the other run")
            continue
        w, i = max_numeric_diff(v["training_oof_prob"], y, f"{key}/training_oof_prob")
        worst, issues = max(worst, w), issues + i
    return worst, issues


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
    # Non-finite values match only themselves (audit R16): |0.8 − NaN| is NaN, which max() would silently drop.
    fa, fb = float(a), float(b)
    if not (math.isfinite(fa) and math.isfinite(fb)):
        same = (math.isnan(fa) and math.isnan(fb)) or fa == fb
        return 0.0, ([] if same else [f"{path}: {a!r} vs {b!r}"])
    return abs(fa - fb), []


# Outputs a reproduction must produce: a missing one is a failure, never a silently skipped check (audit R16).
MANDATORY = ("results/split_manifest.json", "results/metrics.json", "results/stability.json", "registry/replay.json")


def missing_outputs(here: Path, other: Path) -> list[str]:
    return [rel for rel in MANDATORY if (here / rel).exists() and not (other / rel).exists()]


def splits_identical(a: dict, b: dict) -> tuple[bool, list[str]]:
    """Every outer fold's ids exactly equal (a numeric difference is a different split) and the same manifest hash."""
    worst, issues = max_numeric_diff(a, b)
    if worst != 0:
        issues = [f"split ids differ (max |diff| {worst})", *issues]
    if a.get("split_manifest_sha256") != b.get("split_manifest_sha256"):
        issues = ["split_manifest_sha256 differs", *issues]
    return not issues, issues


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
    absent = missing_outputs(ROOT, other)
    check("every expected output present", not absent, f"missing on the other side: {absent}")
    if absent:  # the remaining checks would read the missing files
        (ROOT / "results" / "reproduction.json").write_text(
            json.dumps({"other": other.name, "pass": False, "checks": report}, indent=1), encoding="utf-8")
        print("DIFFERENCES FOUND")
        return 1
    a, b = load(ROOT, "results/split_manifest.json"), load(other, "results/split_manifest.json")
    same, issues = splits_identical(a, b)
    check("split manifest (every outer fold)", same, f"{a['split_manifest_sha256'][:16]}; {issues[:3]}")
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
    worst, issues = golden_diff(load(production_dir(ROOT), "golden/golden_predictions.json")["cases"],
                                load(production_dir(other), "golden/golden_predictions.json")["cases"])
    check("golden predictions", worst <= 1e-6 and not issues, f"max |dp| {worst:.2e}; {issues[:3]}")
    for rel in ("results/stability.json", "registry/replay.json"):
        if (ROOT / rel).exists():  # present here => required there (checked above)
            w, issues = max_numeric_diff(load(ROOT, rel), load(other, rel))
            check(rel, w <= 1e-9 and not issues, f"max |diff| {w:.2e}; {issues[:3]}")
    if (ROOT / "results/fold_ledger_oof.json").exists():
        worst, issues = ledger_diff(load(ROOT, "results/fold_ledger_oof.json")["folds"],
                                    lambda t, k: load(other, f"results/nested/{t}/r0f{k}.json"))
        check("D-019 recomputed fold scores vs a real retrain", worst <= 1e-9 and not issues,
              f"max |diff| {worst:.2e}; {issues[:3]}")
    (ROOT / "results" / "reproduction.json").write_text(json.dumps({"other": other.name, "pass": ok, "checks": report},
                                                                    indent=1), encoding="utf-8")
    print("REPRODUCED" if ok else "DIFFERENCES FOUND")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
