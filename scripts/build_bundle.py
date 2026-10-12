"""Assemble the versioned model bundle + OOF demo bundle from the training outputs (plan §6.11, §10, §11).

  artifacts/models/v{VERSION}/
    manifest.json            {"manifest": {...}, "artifact_manifest_sha256": SHA-256(JCS(manifest))}  (non-circular)
    split_manifest.json  feature_schema.json  strength_cutpoints.json  evaluation/metrics.json  global_importance.json
    targets/{t}/final/       model.joblib calibrator.json thresholds.json reference_context.joblib selection.json
    targets/{t}/folds/k{1..5}/ model.joblib calibrator.json thresholds.json reference_context.joblib   (eval repeat)
    demo_bundle/index.json   {"index": {...artifact_manifest_sha256, files...}, "demo_bundle_sha256": ...}
    demo_bundle/patients/ZAS-xxxx.json   {"bundle": <PatientBundle without app_version>, "ground_truth": {...}}
  registry/models.json       production pointer

The artifact manifest covers model artifacts only; the demo bundle (whose files carry artifact_manifest_sha256) is
hashed in its own index → no hash cycle (D-011). Usage: uv run --group train python scripts/build_bundle.py
"""

from __future__ import annotations

import hashlib
import json
import platform
import shutil
import subprocess
import sys
import uuid
import warnings
from datetime import UTC, datetime
from pathlib import Path

import joblib
import numpy as np
import rfc8785

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "ml"))

from novarion_ml.calibrate.platt import Platt
from novarion_ml.data.canonical import training_data_sha256, training_row_hashes
from novarion_ml.data.load import build_targets, build_X, load_source, patient_id
from novarion_ml.data.registry import CONFIG_DIR, default_registry, load_targets
from novarion_ml.inference.engine import Engine, TargetArtifact
from novarion_ml.thresholds.layers import Qualification, Thresholds
from novarion_ml.train.config import default_train_config
from novarion_ml.uncertainty.reference import Ledger, ReferenceContext

VERSION = "0.1.1"  # corrected evidence/calibration build; preserve the prior v0.1.0 bundle
PREPROCESSING_VERSION = "1.0.0"
TARGETS = ("cad", "lad", "lcx", "rca")
UUID_NAMESPACE = uuid.UUID("6f1d3c1e-6c55-4c5e-9a43-6e6f76617269")
RESULTS = ROOT / "results"
OUT = ROOT / "artifacts" / "models" / f"v{VERSION}"


def sha_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path: Path, obj, compact: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(obj, separators=(",", ":"), ensure_ascii=False) if compact else json.dumps(obj, indent=1,
                                                                                                ensure_ascii=False)
    path.write_text(text + "\n", encoding="utf-8")


def thresholds_from_json(d: dict) -> Thresholds:
    def q(x):
        return None if x is None else Qualification(**x)

    return Thresholds(d["t_op"], d["t_neg"], d["t_pos"], q(d["qualification_negative"]), q(d["qualification_positive"]))


def py(v):
    v = v.item() if hasattr(v, "item") else v
    return int(v) if isinstance(v, float) and v.is_integer() else v


def fold_training_ledger(record: dict, labels) -> Ledger:
    """The query outer-test fold must influence neither the model nor evidence-band membership."""
    ids = record["train_ids"]
    values = record.get("training_oof_prob")
    if values is None or len(values) != len(ids):
        raise ValueError("Legacy or incomplete outer-fold cache has no training-side OOF probabilities. "
                         "Rerun scripts/train.py nested; global OOF scores are unsafe for fold evidence ledgers.")
    probs = np.asarray(values, dtype=float)
    if not np.isfinite(probs).all() or ((probs < 0) | (probs > 1)).any():
        raise ValueError("Invalid training-side OOF ledger probabilities.")
    return Ledger(probs, labels.loc[ids].to_numpy())


def validated_output_dir(out: Path) -> Path:
    """Recursive replacement is confined to versioned artifacts or dedicated in-repo scratch builds."""
    root = ROOT.resolve()
    target = out.resolve()
    allowed = [root / "artifacts" / "models", root / "work" / "bundle-builds"]
    if not any(target != base and target.is_relative_to(base) for base in allowed):
        raise ValueError("Bundle output must be below artifacts/models or work/bundle-builds in this repository.")
    return target


def main(results: Path = RESULTS, out: Path = OUT, registry_file: Path | None = None) -> None:
    warnings.filterwarnings("ignore")
    OUT = validated_output_dir(out)  # dry runs belong under work/bundle-builds
    RESULTS = results
    registry = default_registry()
    targets_cfg = load_targets()
    spec = {t["id"]: t for t in targets_cfg["targets"]}
    train = default_train_config()
    source = load_source()
    X = build_X(source, registry)
    Y = build_targets(source)
    labels = __import__("pandas").DataFrame(Y)
    metrics = json.loads((RESULTS / "metrics.json").read_text(encoding="utf-8"))
    split = json.loads((RESULTS / "split_manifest.json").read_text(encoding="utf-8"))
    ev_repeat = train.evaluation_repeat
    anatomy = json.loads((CONFIG_DIR / "anatomy_manifest.json").read_text(encoding="utf-8"))
    refctx_args = {"n_min_compare": targets_cfg["cohort_comparison_min_n"],
                   "evidence_bands": targets_cfg["evidence_bands"], "band_min_n": targets_cfg["evidence_band_min_n"]}

    # ---------------------------------------------------------------- evaluation-repeat OOF predictions (ledger)
    fold_records = {t: [json.loads((RESULTS / "nested" / t / f"r{ev_repeat}f{k}.json").read_text(encoding="utf-8"))
                        for k in range(train.outer_k)] for t in TARGETS}
    from scripts.train import all_folds, cache_key, validate_fold_record

    key = cache_key()
    if metrics.get("cache_key") != key:
        raise ValueError("Evaluation is stale: rerun nested, final and evaluate before bundle assembly.")
    folds = all_folds(X, Y)
    for t in TARGETS:
        expected = [f for f in folds[t] if f.repeat == ev_repeat]
        for record, fold in zip(fold_records[t], expected, strict=True):
            validate_fold_record(record, fold, t, key, Y[t])
        summary = json.loads((RESULTS / "final" / f"{t}.json").read_text(encoding="utf-8"))
        if summary.get("cache_key") != key:
            raise ValueError(f"Final {t} model is stale: rerun scripts/train.py final before bundle assembly.")
    # Validate evidence inputs before touching any previously built bundle.
    fold_ledgers = {(t, rec["fold"]): fold_training_ledger(rec, Y[t])
                    for t in TARGETS for rec in fold_records[t]}
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)
    oof_prob = {t: {} for t in TARGETS}
    fold_of = {t: {} for t in TARGETS}
    for t in TARGETS:
        for rec in fold_records[t]:
            for rid, p in zip(rec["test_ids"], rec["test"]["prob"], strict=True):
                oof_prob[t][rid] = p
                fold_of[t][rid] = rec["fold"]

    def ledger(t: str, ids) -> Ledger:
        ids = [int(i) for i in ids]
        return Ledger(np.array([oof_prob[t][i] for i in ids]), Y[t].loc[ids].to_numpy())

    # ---------------------------------------------------------------- fold artifacts (OOF serving)
    fold_art: dict[tuple[str, int], TargetArtifact] = {}
    refctx_sha: dict[tuple[str, int | str], str] = {}
    evaluation = {t: metrics["targets"][t]["table2"] for t in TARGETS}
    placeholder = {"q1": 0.0, "q2": 0.0}
    for t in TARGETS:
        for rec in fold_records[t]:
            k = rec["fold"]
            d = OUT / "targets" / t / "folds" / f"k{k + 1}"
            d.mkdir(parents=True)
            model = joblib.load(RESULTS / "nested" / "models" / f"{t}_r{ev_repeat}_f{k}.joblib")
            train_ids = rec["train_ids"]
            ref = ReferenceContext(X.loc[train_ids], labels, {t: fold_ledgers[(t, k)]},
                                   scope=f"{t} fold k{k + 1} outer-training (eval repeat {ev_repeat})", **refctx_args)
            platt = Platt(rec["platt"]["a"], rec["platt"]["b"])
            thr = thresholds_from_json(rec["thresholds"])
            joblib.dump(model, d / "model.joblib")
            joblib.dump(ref, d / "reference_context.joblib")
            write_json(d / "calibrator.json", platt.to_json())
            write_json(d / "thresholds.json", rec["thresholds"])
            refctx_sha[(t, k)] = sha_file(d / "reference_context.joblib")
            fold_art[(t, k)] = TargetArtifact(t, spec[t]["display"], spec[t]["anatomy_key"], model, platt, thr, ref,
                                              placeholder, evaluation[t])

    def oof_engine(rid: int) -> Engine:
        return Engine({t: fold_art[(t, fold_of[t][rid])] for t in TARGETS}, mode="oof", registry=registry)

    canonical = {int(rid): {fid: py(v) for fid, v in X.loc[rid].items()} for rid in X.index}

    # ---------------------------------------------------------------- strength tertiles over the OOF population
    pooled: dict[str, list[float]] = {t: [] for t in TARGETS}
    for rid in X.index:
        for t, values in oof_engine(int(rid)).raw_feature_contributions(canonical[int(rid)]).items():
            pooled[t].extend(values)
    strength = {t: {"q1": float(np.percentile(pooled[t], 100 / 3)), "q2": float(np.percentile(pooled[t], 200 / 3))}
                for t in TARGETS}
    for art in fold_art.values():
        art.strength = strength[art.target]
    write_json(OUT / "strength_cutpoints.json", {"method": "tertiles of |calibrated contribution| over the OOF "
                                                 "population (eval repeat), numpy linear interpolation", **strength})

    # ---------------------------------------------------------------- final models (new / edited cases)
    final_art: dict[str, TargetArtifact] = {}
    for t in TARGETS:
        d = OUT / "targets" / t / "final"
        d.mkdir(parents=True)
        fin = joblib.load(RESULTS / "final" / f"{t}.joblib")
        summary = json.loads((RESULTS / "final" / f"{t}.json").read_text(encoding="utf-8"))
        ref = ReferenceContext(X, labels, {t: ledger(t, X.index)}, scope="full cohort (303)", **refctx_args)
        joblib.dump(fin["model"], d / "model.joblib")
        joblib.dump(ref, d / "reference_context.joblib")
        write_json(d / "calibrator.json", fin["platt"].to_json())
        write_json(d / "thresholds.json", fin["thresholds"].to_json())
        write_json(d / "selection.json", {k: v for k, v in summary.items() if k not in ("inner",)})
        refctx_sha[(t, "final")] = sha_file(d / "reference_context.joblib")
        final_art[t] = TargetArtifact(t, spec[t]["display"], spec[t]["anatomy_key"], fin["model"], fin["platt"],
                                      fin["thresholds"], ref, strength[t], evaluation[t])

    # ---------------------------------------------------------------- global importance (OOF attribution)
    global_imp = {}
    for t in TARGETS:
        per: dict[str, list[float]] = {}
        for rid in X.index:
            art = fold_art[(t, fold_of[t][int(rid)])]
            frame = Engine({t: art}, "oof", registry)._frame(canonical[int(rid)])
            _, raw = art.model.raw_contributions(frame)
            agg: dict[str, float] = {}
            for v, origin in zip(raw[0], art.model.origins, strict=True):
                agg[origin] = agg.get(origin, 0.0) + art.platt.a * float(v)
            for fid, v in agg.items():
                per.setdefault(fid, []).append(abs(v))
        by_id = registry.by_id()
        global_imp[t] = sorted(({"feature": f, "display": by_id[f].display, "mean_abs_contribution": float(np.mean(v)),
                                 "points": []} for f, v in per.items()),
                               key=lambda r: (-r["mean_abs_contribution"], r["feature"]))
    write_json(OUT / "global_importance.json", global_imp)

    # ---------------------------------------------------------------- shared files + artifact manifest
    write_json(OUT / "split_manifest.json", split)
    write_json(OUT / "evaluation" / "metrics.json", metrics)
    write_json(OUT / "feature_schema.json", {"schema_version": registry.schema_version,
                                             "features": [f.__dict__ | {"source_tokens": {str(k): v for k, v in
                                                          f.source_tokens.items()}} for f in registry.features]})
    files = {str(p.relative_to(OUT)).replace("\\", "/"): sha_file(p) for p in sorted(OUT.rglob("*")) if p.is_file()}
    try:
        git_sha = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True,
                                 check=False).stdout.strip()
    except OSError:
        git_sha = ""
    import catboost
    import interpret
    import sklearn
    import xgboost

    manifest = {
        "model_version": VERSION, "preprocessing_version": PREPROCESSING_VERSION,
        "source_data_sha256": json.loads((CONFIG_DIR / "data_source.json").read_text())["source_data_sha256"],
        "training_data_sha256": training_data_sha256(X, Y),
        "split_manifest_sha256": split["split_manifest_sha256"],
        "schema_report_sha256": sha_file(ROOT / "data" / "schema_report.json"),
        "feature_schema_sha256": sha_file(CONFIG_DIR / "feature_registry.yaml"),
        "target_schema_sha256": sha_file(CONFIG_DIR / "targets.yaml"),
        "train_config_sha256": train.sha256,
        "anatomy_version": anatomy["manifest"]["anatomy_version"],
        "anatomy_asset_sha256": anatomy["anatomy_asset_sha256"],
        "anatomy_map_sha256": sha_file(CONFIG_DIR / "anatomy_map.json"),
        "reference_context_sha256": {f"{t}:{k if k == 'final' else f'k{k + 1}'}": v for (t, k), v in refctx_sha.items()},
        "selected": {t: json.loads((RESULTS / "final" / f"{t}.json").read_text())["selected"] for t in TARGETS},
        "files": files, "git_sha": git_sha or None, "seeds": train.seeds, "evaluation_repeat_id": ev_repeat,
        "oof_ledger_method": "outer_training_inner_crossfit",
        "training_cache_key": key,
        "libraries": {"python": platform.python_version(), "numpy": np.__version__, "scikit-learn": sklearn.__version__,
                      "xgboost": xgboost.__version__, "catboost": catboost.__version__,
                      "interpret": interpret.__version__},
        "created_at": datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
    }
    artifact_sha = hashlib.sha256(rfc8785.dumps(manifest)).hexdigest()
    write_json(OUT / "manifest.json", {"manifest": manifest, "artifact_manifest_sha256": artifact_sha})

    # ---------------------------------------------------------------- OOF patient bundles (demo bundle)
    row_hash = training_row_hashes(X)
    demo = OUT / "demo_bundle"
    patients_index = []
    for rid in sorted(int(i) for i in X.index):
        pid = patient_id(rid)
        out = oof_engine(rid).analyze(canonical[rid], exclude_id=rid)
        source_id = f"oof:{VERSION}:{pid}"
        refs = {t: refctx_sha[(t, fold_of[t][rid])] for t in TARGETS}
        bundle = {
            "analysis_id": str(uuid.uuid5(UUID_NAMESPACE, source_id)), "model_version": VERSION,
            "preprocessing_version": PREPROCESSING_VERSION, "anatomy_version": manifest["anatomy_version"],
            "anatomy_asset_sha256": manifest["anatomy_asset_sha256"], "input_sha256": row_hash[rid],
            "training_data_sha256": manifest["training_data_sha256"], "artifact_manifest_sha256": artifact_sha,
            "reference_context_sha256": hashlib.sha256(rfc8785.dumps(refs)).hexdigest(),
            "target_status": {t: "complete" for t in TARGETS}, "patient": {"prediction_mode": "oof"},
            "quality": out["quality"], "targets": out["targets"],
            "source_oof_analysis_id": source_id, "patient_id": pid,
            "outer_folds": {t: fold_of[t][rid] + 1 for t in TARGETS},
            "canonical_inputs": canonical[rid], "explanations": out["explanations"], "evidence": out["evidence"],
        }
        write_json(demo / "patients" / f"{pid}.json",
                   {"bundle": bundle, "ground_truth": {t: int(Y[t].loc[rid]) for t in TARGETS}}, compact=True)
        x = canonical[rid]
        patients_index.append({
            "patient_id": pid, "dataset_record_id": rid, "expected_input_sha256": row_hash[rid],
            "age": x["age"], "sex": "male" if x["sex"] == 1 else "female",
            "key_risk_factors": [f for f in ("diabetes", "hypertension", "current_smoker", "family_history",
                                             "dyslipidemia", "obesity") if x[f] == 1],
        })
    patient_files = {f"patients/{p.name}": sha_file(p) for p in sorted((demo / "patients").iterdir())}
    index = {"bundle_schema_version": "1.0.0", "frontend_compatibility_range": ">=0.1.0 <1.0.0",
             "model_version": VERSION, "artifact_manifest_sha256": artifact_sha, "patients": patients_index,
             "files": patient_files}
    write_json(demo / "index.json", {"index": index, "demo_bundle_sha256": hashlib.sha256(rfc8785.dumps(index)).hexdigest()})

    # ---------------------------------------------------------------- registry pointer
    registry_file = registry_file or ROOT / "registry" / "models.json"
    write_json(registry_file, {"production_version": VERSION, "models": [{
        "version": VERSION, "status": "production", "created_at": manifest["created_at"], "training_cases": len(X),
        "artifact_manifest_sha256": artifact_sha, "path": str(OUT.relative_to(ROOT)).replace("\\", "/")
        if OUT.is_relative_to(ROOT) else str(OUT),
    }]})
    print(f"bundle v{VERSION}: {len(files)} artifact files, {len(patient_files)} patient files, "
          f"artifact_manifest_sha256={artifact_sha[:12]}...")


if __name__ == "__main__":
    main()
