"""Sample import files for the New case → Import flow (frontend/public/samples/). Usage: uv run python scripts/build_samples.py

  novarion_case_template.csv        header only: every entered feature as "id [canonical unit]"
  dataset_patient_ZAS-0003.csv      a public dataset record + its label columns (to show leakage stripping)
  three_dataset_patients.csv        multi-row file → row picker
  synthetic_case.json               a made-up de-identified case using source tokens and one UNKNOWN value
"""

from __future__ import annotations

import csv
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "ml"))

from novarion_ml.data.load import build_targets, build_X, load_source, patient_id
from novarion_ml.data.registry import default_registry

OUT = ROOT / "frontend" / "public" / "samples"
LABEL_COLUMNS = {"cad": "Cath", "lad": "LAD", "lcx": "LCX", "rca": "RCA"}
LABEL_TOKENS = {"cad": ("Normal", "CAD"), "lad": ("Normal", "Stenotic"), "lcx": ("Normal", "Stenotic"),
                "rca": ("Normal", "Stenotic")}


def main() -> None:
    registry = default_registry()
    entered = [f for f in registry.features if f.input_mode == "entered"]
    header = ["dataset_record_id"] + [f"{f.id} [{f.canonical_unit}]" if f.canonical_unit else f.id for f in entered]
    source = load_source()
    X, Y = build_X(source, registry), build_targets(source)
    OUT.mkdir(parents=True, exist_ok=True)

    def row(record: int, labels: bool) -> list:
        values = [patient_id(record)]
        for f in entered:
            v = X.loc[record, f.id]
            v = v.item() if hasattr(v, "item") else v
            values.append(int(v) if isinstance(v, float) and v.is_integer() else v)
        if labels:
            values += [LABEL_TOKENS[t][int(Y[t].loc[record])] for t in LABEL_COLUMNS]
        return values

    with open(OUT / "novarion_case_template.csv", "w", newline="", encoding="utf-8") as fh:
        csv.writer(fh).writerow(header[1:])
    with open(OUT / "dataset_patient_ZAS-0003.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(header + list(LABEL_COLUMNS.values()))
        w.writerow(row(2, labels=True))
    with open(OUT / "three_dataset_patients.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(header)
        for record in (2, 3, 5):
            w.writerow(row(record, labels=False))

    synthetic = {  # made-up values (not a real person); uses source tokens the importer must map
        "age": 61, "weight": 82, "height": 172, "sex": "Male", "diabetes": "Yes", "hypertension": "Yes",
        "current_smoker": "No", "ex_smoker": "Yes", "family_history": "No", "chronic_renal_failure": "N",
        "cerebrovascular_accident": "N", "airway_disease": "N", "thyroid_disease": "N",
        "congestive_heart_failure": "N", "dyslipidemia": "Y", "blood_pressure": 145, "pulse_rate": 78, "edema": 0,
        "weak_peripheral_pulse": "N", "lung_rales": "N", "systolic_murmur": "N", "diastolic_murmur": "N",
        "typical_chest_pain": 1, "dyspnea": "N", "function_class": "1", "atypical_chest_pain": "N",
        "nonanginal_chest_pain": "N", "low_threshold_angina": "N", "q_wave": 0, "st_elevation": 0,
        "st_depression": 1, "t_inversion": 1, "lvh": "N", "poor_r_progression": "N", "bundle_branch_block": "none",
        "fasting_blood_sugar": 128, "creatinine": 1.1, "triglycerides": 190, "ldl": "unknown", "hdl": 36,
        "bun": 18, "esr": 22, "hemoglobin": 14.2, "potassium": 4.4, "sodium": 140, "wbc": 7600,
        "lymphocytes_pct": 30, "neutrophils_pct": 62, "platelets": 240, "ejection_fraction": 45,
        "region_rwma": "1", "valvular_heart_disease": "mild",
    }
    missing = {f.id for f in entered} - set(synthetic)
    assert not missing, f"synthetic case misses {missing}"
    (OUT / "synthetic_case.json").write_text(
        json.dumps({"note": "Synthetic, de-identified example (not a real person). Units = registry canonical units.",
                    "inputs": synthetic}, indent=1) + "\n", encoding="utf-8")
    print(f"samples written to {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
