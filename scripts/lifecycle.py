"""Governed learning-loop CLI (plan §12B). The CLI is authoritative; the hosted demo has no write path.

  verify-outcomes --package P --attest A --steward NAME     steward verification → registry/verification_manifest.json
  candidate --package P --version X.Y.Z [--families lr,..]  challenger + forward holdout + paired gate → candidate
  promote --version X.Y.Z --approver NAME                   human-approved promotion of a gate-PASS candidate
  reject --version X.Y.Z --approver NAME --reason TEXT      record a human rejection
  rollback --version X.Y.Z --approver NAME                  restore a previous production bundle
  verify-log                                                check the lifecycle log hash chain
  status                                                    registry + verification summary

Every promote / reject / rollback (and each verification run and candidate) appends one entry to
registry/lifecycle_log.jsonl. Restart the backend after promote/rollback to deploy the new production bundle.
Usage: uv run --group train --group inference python scripts/lifecycle.py <command> [...]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import warnings
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "ml"))
sys.path.insert(0, str(ROOT / "backend"))

from novarion_ml.data.canonical import training_row_hashes
from novarion_ml.data.load import build_targets, build_X, load_source
from novarion_ml.data.registry import CONFIG_DIR, default_registry
from novarion_ml.hashing import text_sha256
from novarion_ml.lifecycle.candidate import build_candidate
from novarion_ml.lifecycle.gate import load_gate
from novarion_ml.lifecycle.log import LifecycleLog
from novarion_ml.lifecycle.package import load_package
from novarion_ml.lifecycle.procedure import restrict
from novarion_ml.lifecycle.promote import (
    PromotionError,
    entry,
    promote,
    read_registry,
    record_verification,
    register_candidate,
    reject,
    rollback,
)
from novarion_ml.lifecycle.verify import eligible, empty_manifest, verify_outcomes
from novarion_ml.train.config import default_train_config


class Paths:
    """Where the lifecycle state lives. Tests point it at a scratch root and inject a small grid / gate config."""

    def __init__(self, root: Path = ROOT, tests_runner=None, gate: dict | None = None, train=None):
        self.root = root
        self.tests_runner = tests_runner or _tests_pass
        self.gate = gate
        self.train = train
        self.registry = root / "registry" / "models.json"
        self.log = LifecycleLog(root / "registry" / "lifecycle_log.jsonl")
        self.manifest = root / "registry" / "verification_manifest.json"
        self.candidates = root / "artifacts" / "candidates"


def _verify_bundle(path: Path):
    from app.bundle_service import verify_bundle

    return verify_bundle(path)


def _data():
    source = load_source()
    X = build_X(source)
    return X, build_targets(source)


def _manifest(paths: Paths) -> dict:
    return json.loads(paths.manifest.read_text(encoding="utf-8")) if paths.manifest.exists() else empty_manifest()


def cmd_verify_outcomes(a, paths: Paths) -> int:
    records, notes = load_package(Path(a.package).read_text(encoding="utf-8"))
    attest = json.loads(Path(a.attest).read_text(encoding="utf-8"))
    X, _ = _data()
    base = _manifest(paths) if paths.manifest.exists() else None
    manifest, report = verify_outcomes(records, attest, base or empty_manifest(), set(training_row_hashes(X).values()))
    package_sha = hashlib.sha256(Path(a.package).read_bytes()).hexdigest()
    # Locked and journaled like every registry change; refused if the manifest changed while this ran (audit N08).
    record_verification(registry_file=paths.registry, log=paths.log, actor=a.steward, manifest=manifest,
                        base_sha256=base["verification_manifest_sha256"] if base else None,
                        details={"package_sha256": package_sha, "counts": {k: len(v) for k, v in report.items()}})
    for note in notes:
        print(f"note: {note}")
    for k, v in report.items():
        print(f"{k:24s} {len(v)}" + (f"  {v}" if v and k != "unchanged_existing" else ""))
    return 0


def _tests_pass() -> bool:
    """'All tests pass' gate input: leakage, additivity, contract, anatomy map, OOF consistency, lifecycle."""
    cmd = [sys.executable, "-m", "pytest", "-q", "-x", "tests/test_leakage.py", "tests/test_ml_core.py",
           "tests/test_api_contract.py", "tests/test_anatomy.py", "tests/test_lifecycle.py"]
    return subprocess.run(cmd, cwd=ROOT, check=False).returncode == 0


def cmd_candidate(a, paths: Paths) -> int:
    records, notes = load_package(Path(a.package).read_text(encoding="utf-8"))
    reg = read_registry(paths.registry)
    prod = entry(reg, reg["production_version"])
    _verify_bundle(paths.root / prod["path"])
    X, Y = _data()
    out = paths.candidates / f"v{a.version}"
    if out.exists() or any(m["version"] == a.version for m in reg["models"]):
        raise PromotionError(f"version {a.version} already exists (versions are immutable)")
    train = paths.train or restrict(default_train_config(), a.families.split(",") if a.families else None)
    doc = build_candidate(records=records, manifest=_manifest(paths), log=paths.log, X=X, Y=Y, train=train,
                          gate=paths.gate or load_gate(), champion_version=reg["production_version"],
                          champion_dir=paths.root / prod["path"], version=a.version, out_dir=out,
                          feature_schema_sha256=text_sha256(CONFIG_DIR / "feature_registry.yaml"),
                          preprocessing_version="1.0.0", tests_pass=paths.tests_runner())
    report = doc["report"]
    # Locked and journaled; refused if production changed while the candidate was built (audit N08).
    register_candidate(registry_file=paths.registry, log=paths.log, actor=a.actor, version=a.version, doc=doc,
                       path=str(out.relative_to(paths.root)).replace("\\", "/"),
                       training_cases=report.get("challenger_training_cases", len(X)),
                       champion=reg["production_version"],
                       details={"candidate": a.version, "gate_status": report["gate_status"],
                                "gate_report_sha256": doc["gate_report_sha256"],
                                "verification_manifest_sha256": report["verification_manifest_sha256"],
                                "champion": reg["production_version"]})
    for note in notes + report["notes"]:
        print(f"note: {note}")
    print(f"candidate v{a.version}: gate {report['gate_status']}" + (f" ({report['reason']})" if "reason" in report else ""))
    for t, r in report["targets"].items():
        if r["evaluable"]:
            print(f"  {t}: AUC {r['auc_champion']:.3f} -> {r['auc_challenger']:.3f}  dAUC CI {r['delta_auc_ci95']}  "
                  f"rules {r['rules']}")
    return 0


def cmd_promote(a, paths: Paths) -> int:
    X, Y = _data()
    out = promote(root=paths.root, registry_file=paths.registry, log=paths.log, version=a.version, actor=a.approver,
                  X=X, Y=Y, train=paths.train or default_train_config(), registry=default_registry(), verify=_verify_bundle)
    print(f"promoted v{a.version} -> production ({out}); restart the backend to deploy it")
    return 0


def cmd_reject(a, paths: Paths) -> int:
    reject(root=paths.root, registry_file=paths.registry, log=paths.log, version=a.version, actor=a.approver,
           reason=a.reason)
    print(f"v{a.version} rejected; production unchanged")
    return 0


def cmd_rollback(a, paths: Paths) -> int:
    rollback(root=paths.root, registry_file=paths.registry, log=paths.log, version=a.version, actor=a.approver,
             verify=_verify_bundle)
    print(f"production restored to v{a.version}; restart the backend to deploy it")
    return 0


def cmd_verify_log(a, paths: Paths) -> int:
    entries = paths.log.verify()
    print(f"lifecycle log OK: {len(entries)} entries, chain intact")
    return 0


def cmd_status(a, paths: Paths) -> int:
    reg = read_registry(paths.registry)
    print(f"production: v{reg['production_version']}")
    for m in reg["models"]:
        print(f"  v{m['version']:8s} {m['status']:10s} {m.get('gate_status') or '':22s} {m['training_cases']} cases")
    records = _manifest(paths)["verification_manifest"]["records"].values()
    print(f"verified outcomes: {sum(r['outcome_status'] == 'verified' for r in records)}, "
          f"training-eligible: {sum(eligible(r) for r in records)}")
    print(f"lifecycle log: {len(paths.log.verify())} entries, chain intact")
    return 0


def main(argv: list[str] | None = None, paths: Paths | None = None) -> int:
    warnings.filterwarnings("ignore")
    p = argparse.ArgumentParser(prog="lifecycle")
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("verify-outcomes")
    s.add_argument("--package", required=True)
    s.add_argument("--attest", required=True)
    s.add_argument("--steward", required=True)
    s = sub.add_parser("candidate")
    s.add_argument("--package", required=True)
    s.add_argument("--version", required=True)
    s.add_argument("--actor", default="model steward")
    s.add_argument("--families", default=None, help="restrict the grid (tests/smoke only; recorded in the report)")
    for name in ("promote", "rollback"):
        s = sub.add_parser(name)
        s.add_argument("--version", required=True)
        s.add_argument("--approver", required=True)
    s = sub.add_parser("reject")
    s.add_argument("--version", required=True)
    s.add_argument("--approver", required=True)
    s.add_argument("--reason", required=True)
    sub.add_parser("verify-log")
    sub.add_parser("status")
    a = p.parse_args(argv)
    handlers = {"verify-outcomes": cmd_verify_outcomes, "candidate": cmd_candidate, "promote": cmd_promote,
                "reject": cmd_reject, "rollback": cmd_rollback, "verify-log": cmd_verify_log, "status": cmd_status}
    try:
        return handlers[a.cmd](a, paths or Paths())
    except (PromotionError, ValueError, RuntimeError) as e:
        print(f"refused: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
