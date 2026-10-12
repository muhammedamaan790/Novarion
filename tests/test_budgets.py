"""Offline demo-bundle size budgets (plan §11A "Offline bundle": per-patient lazy loading keeps browser RAM bounded).

Budgets: the whole demo_bundle/ ≤ 25 MB gzipped · index.json ≤ 1 MB · each patient file ≤ 200 KB.
Checked on the production bundle (skipped where no trained bundle exists, e.g. CI).
"""

import gzip
import json

import pytest

from novarion_ml.data.registry import ROOT

BUDGET_TOTAL_GZIP = 25 * 1024 * 1024
BUDGET_INDEX = 1024 * 1024
BUDGET_PATIENT = 200 * 1024


def _demo_bundle():
    registry = json.loads((ROOT / "registry" / "models.json").read_text(encoding="utf-8"))
    entry = next(m for m in registry["models"] if m["version"] == registry["production_version"])
    return ROOT / entry["path"] / "demo_bundle"


DEMO = _demo_bundle()
pytestmark = pytest.mark.skipif(not DEMO.exists(), reason="no trained bundle (scripts/build_bundle.py)")


def test_demo_bundle_meets_the_size_budgets():
    files = [p for p in DEMO.rglob("*") if p.is_file()]
    gz_total = sum(len(gzip.compress(p.read_bytes(), compresslevel=6)) for p in files)
    assert gz_total <= BUDGET_TOTAL_GZIP, f"demo bundle is {gz_total / 1e6:.1f} MB gzipped (budget 25 MB)"
    assert (DEMO / "index.json").stat().st_size <= BUDGET_INDEX
    patients = list((DEMO / "patients").glob("*.json"))
    assert len(patients) == 303
    largest = max(p.stat().st_size for p in patients)
    assert largest <= BUDGET_PATIENT, f"largest patient file is {largest / 1024:.0f} KB (budget 200 KB)"
