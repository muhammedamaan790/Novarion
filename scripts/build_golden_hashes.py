"""Freeze the input_sha256 golden vectors (plan §11: ≥ 50 vectors, backend is the only hash authority).

Writes tests/golden/input_sha256_vectors.json: 40 dataset rows + edge cases (UNKNOWN, -0, canonical-precision
round-half-even boundaries, integral floats, whitespace around category tokens). Run ONCE; afterwards the test
suite recomputes every vector and any difference is a canonicalization change = MAJOR preprocessing-version bump.
Usage: uv run python scripts/build_golden_hashes.py [--force]
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "ml"))

from novarion_ml.data.canonical import canonicalize_case
from novarion_ml.data.load import build_X, load_source, patient_id
from novarion_ml.data.registry import default_registry

OUT = ROOT / "tests" / "golden" / "input_sha256_vectors.json"


def main() -> None:
    if OUT.exists() and "--force" not in sys.argv:
        sys.exit(f"{OUT.relative_to(ROOT)} exists; golden vectors are frozen (use --force only for a MAJOR bump)")
    registry = default_registry()
    entered = [f.id for f in registry.features if f.input_mode == "entered"]
    X = build_X(load_source(), registry)

    def row(record: int) -> dict:
        return {fid: (v.item() if hasattr(v, "item") else v) for fid, v in X.loc[record, entered].items()}

    vectors = []
    for record in range(0, 303, 8)[:40]:  # 40 rows spread across the file
        vectors.append({"name": f"dataset_{patient_id(record)}", "inputs": row(record)})
    base = row(0)
    edge_cases = {
        "unknown_ldl": {"ldl": "__UNKNOWN__"},
        "unknown_weight_makes_bmi_and_obesity_unknown": {"weight": "__UNKNOWN__"},
        "unknown_category_field": {"valvular_heart_disease": "__UNKNOWN__"},
        "negative_zero_esr": {"esr": -0.0},
        "integral_float_age": {"age": float(base["age"])},
        "creatinine_half_even_down_1_005": {"creatinine": 1.005},
        "creatinine_half_even_up_1_015": {"creatinine": 1.015},
        "hdl_half_even_35_25": {"hdl": 35.25},
        "hdl_half_even_35_35": {"hdl": 35.35},
        "potassium_extra_decimals_4_449": {"potassium": 4.449},
        "category_token_with_whitespace": {"bundle_branch_block": "  lbbb "},
        "bmi_boundary_exactly_25": {"weight": 81, "height": 180},  # 25.0 → obesity 0 (BMI > 25 rule)
    }
    for name, patch in edge_cases.items():
        vectors.append({"name": name, "inputs": {**base, **patch}})
    for v in vectors:
        result = canonicalize_case(v["inputs"])
        if not result.ready:
            sys.exit(f"vector {v['name']} is blocked: {[i.code for i in result.issues]}")
        v["canonical"] = result.canonical
        v["input_sha256"] = result.input_sha256
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps({"preprocessing_major": 1, "vectors": vectors}, indent=1) + "\n", encoding="utf-8")
    print(f"{len(vectors)} vectors written to {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
