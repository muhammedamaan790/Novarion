"""Day-2 data verification: profile the downloaded dataset and write data/schema_report.json.

This report is the single source of truth for column counts, label definitions, prevalence,
duplicates and value sets. Every number in the docs/UI/report must come from it.
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
XLSX = ROOT / "data" / "raw" / "z_alizadeh_sani_extension.xlsx"
PIN_FILE = ROOT / "config" / "data_source.json"
REPORT = ROOT / "data" / "schema_report.json"

LABEL_COLUMNS = ["Cath", "LAD", "LCX", "RCA", "CAD"]  # CAD may or may not exist as its own column
POSITIVE_TOKENS = {"Cath": "CAD", "LAD": "Stenotic", "LCX": "Stenotic", "RCA": "Stenotic", "CAD": None}


def sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def as_jsonable(value):
    if hasattr(value, "item"):
        return value.item()
    return value


def main() -> int:
    pin = json.loads(PIN_FILE.read_text(encoding="utf-8"))
    actual_sha = sha256_of(XLSX)
    if actual_sha != pin["source_data_sha256"]:
        print("ERROR: source data does not match the pinned checksum; run scripts/download_data.py")
        return 1

    workbook = pd.ExcelFile(XLSX)
    sheets = {}
    for name in workbook.sheet_names:
        frame = workbook.parse(name)
        sheets[name] = {"shape": list(frame.shape), "columns": [str(c) for c in frame.columns][:80]}

    data_sheet = workbook.sheet_names[0]
    df = workbook.parse(data_sheet)

    labels_present = [c for c in LABEL_COLUMNS if c in df.columns]
    predictors = [c for c in df.columns if c not in labels_present]

    columns = []
    for col in df.columns:
        series = df[col]
        values = series.dropna().unique()
        entry = {
            "name": str(col),
            "role": "label" if col in labels_present else "predictor",
            "dtype": str(series.dtype),
            "n_unique": len(values),
            "n_missing": int(series.isna().sum()),
        }
        if len(values) <= 12:
            entry["value_counts"] = {str(k): int(v) for k, v in series.value_counts().sort_index().items()}
        else:
            entry["min"] = as_jsonable(series.min())
            entry["max"] = as_jsonable(series.max())
        entry["zero_variance"] = len(values) <= 1
        columns.append(entry)

    # Binary 0/1 versions of the labels
    y = {}
    for col in labels_present:
        token = POSITIVE_TOKENS.get(col)
        if token is not None:
            y[col] = (df[col] == token).astype(int)
    prevalence = {
        col: {"n_positive": int(s.sum()), "n_negative": int(len(s) - s.sum()), "prevalence": round(float(s.mean()), 4)}
        for col, s in y.items()
    }

    # Label relationship: is Cath (overall CAD) == OR(LAD, LCX, RCA)?
    relationship = {}
    if all(k in y for k in ("Cath", "LAD", "LCX", "RCA")):
        any_vessel = ((y["LAD"] + y["LCX"] + y["RCA"]) > 0).astype(int)
        crosstab = pd.crosstab(y["Cath"], any_vessel)
        relationship = {
            "definition_tested": "Cath == 'CAD'  vs  any of LAD/LCX/RCA == 'Stenotic'",
            "crosstab_cath_rows_anyvessel_cols": {
                str(r): {str(c): int(crosstab.loc[r, c]) for c in crosstab.columns} for r in crosstab.index
            },
            "agreement": int((y["Cath"] == any_vessel).sum()),
            "disagreement": int((y["Cath"] != any_vessel).sum()),
            "labels_nested": bool((y["Cath"] == any_vessel).all()),
            "n_stenotic_vessels_distribution": {
                str(k): int(v) for k, v in (y["LAD"] + y["LCX"] + y["RCA"]).value_counts().sort_index().items()
            },
        }

    # Duplicates on predictor values, and conflicting labels inside duplicate groups
    feature_frame = df[predictors]
    dup_mask = feature_frame.duplicated(keep=False)
    dup_groups = []
    conflicting = []
    if dup_mask.any():
        for _, group in df[dup_mask].groupby(predictors, dropna=False):
            rows = [int(i) for i in group.index]
            dup_groups.append(rows)
            for col in y:
                if y[col].loc[group.index].nunique() > 1:
                    conflicting.append({"rows": rows, "label": col})

    report = {
        "source_data_sha256": actual_sha,
        "sheets": sheets,
        "data_sheet": data_sheet,
        "n_rows": int(df.shape[0]),
        "n_columns_total": int(df.shape[1]),
        "n_predictor_columns": len(predictors),
        "label_columns": labels_present,
        "separate_cad_column_present": "CAD" in df.columns,
        "overall_cad_label_source": "CAD" if "CAD" in df.columns else "Cath",
        "id_column_present": False,
        "any_missing_values": bool(df.isna().any().any()),
        "zero_variance_predictors": [c["name"] for c in columns if c["zero_variance"] and c["role"] == "predictor"],
        "prevalence": prevalence,
        "label_relationship": relationship,
        "duplicate_predictor_rows": {"n_groups": len(dup_groups), "groups": dup_groups},
        "conflicting_label_duplicate_groups": conflicting,
        "columns": columns,
    }
    REPORT.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
