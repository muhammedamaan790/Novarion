"""Error analysis on the pooled OOF predictions (prespecified repeat) — plan §18 p4 "representative error analysis".

Representative cases are picked by RULES stated in the output (lowest patient id meeting each criterion), never by
browsing: (1) correct high-confidence, (2) high-confidence error (else any error), (3) nearest the operating threshold,
(4) atypical profile. Plus per-target error counts by confidence region and a descriptive comparison of misclassified
vs correctly classified patients. Writes results/error_analysis.md (+ .json). Usage: uv run python scripts/error_analysis.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TARGETS = ("cad", "lad", "lcx", "rca")
SHORT = {"cad": "CAD", "lad": "LAD", "lcx": "LCX", "rca": "RCA"}
DESCRIBE = [("age", "Age (y)"), ("typical_chest_pain", "Typical chest pain"), ("region_rwma", "Region RWMA ≠ 0"),
            ("ejection_fraction", "EF (%)"), ("diabetes", "Diabetes"), ("hypertension", "Hypertension"), ("sex", "Male")]


def bundle_dir() -> Path:
    reg = json.loads((ROOT / "registry" / "models.json").read_text(encoding="utf-8"))
    entry = next(m for m in reg["models"] if m["version"] == reg["production_version"])
    return ROOT / entry["path"]


def load_patients() -> list[dict]:
    out = []
    for path in sorted((bundle_dir() / "demo_bundle" / "patients").iterdir()):
        doc = json.loads(path.read_text(encoding="utf-8"))
        out.append({"bundle": doc["bundle"], "truth": doc["ground_truth"]})
    return out


def value(p: dict, fid: str) -> float:
    v = p["bundle"]["canonical_inputs"][fid]
    return float(v != "0") if fid == "region_rwma" else float(v)


def summarize_case(p: dict, rule: str, focus: str) -> dict:
    b = p["bundle"]
    top = b["explanations"][focus]["contributions"][:4]
    return {
        "rule": rule, "patient_id": b["patient_id"], "focus_target": focus,
        "predictions": {t: {"probability": round(b["targets"][t]["probability"], 3),
                            "predicted": b["targets"][t]["predicted_class"],
                            "confidence": b["targets"][t]["model_confidence"],
                            "label": p["truth"][t]} for t in TARGETS},
        "atypical": b["quality"]["atypical_profile"],
        "top_contributions": [f"{c['display']} = {c['display_value']} ({c['direction']}, {c['strength']})" for c in top],
    }


def main() -> None:
    patients = load_patients()
    index = json.loads((bundle_dir() / "demo_bundle" / "index.json").read_text(encoding="utf-8"))["index"]
    report: dict = {"scope": "pooled OOF predictions of the prespecified outer repeat (each patient exactly once), "
                             "with the model confidence AS DISPLAYED (after every display gate)",
                    # Bound to the bundle it was computed from (audit R08): the report refuses a mismatch.
                    "model_version": index["model_version"], "artifact_manifest_sha256": index["artifact_manifest_sha256"],
                    "targets": {}, "representative_cases": []}
    md = ["# NOVARION error analysis", "",
          ("Scope: **pooled OOF (prespecified repeat)** — every patient predicted by a model that never saw them. "
           "Representative cases are selected by the stated rule (lowest patient id meeting it), not by browsing."), ""]
    md += ["## Errors by confidence region", "",
           "| Target | Errors / n | FP | FN | Errors shown with HIGH model confidence | Errors shown with LOW |", "|---|---|---|---|---|---|"]
    for t in TARGETS:
        rows = [(p, p["bundle"]["targets"][t], p["truth"][t]) for p in patients]
        wrong = [(p, pred, y) for p, pred, y in rows if (pred["predicted_class"] == "positive") != (y == 1)]
        fp = sum(1 for _, pred, y in wrong if y == 0)
        high = sum(1 for _, pred, _ in wrong if pred["model_confidence"] == "high")
        report["targets"][t] = {"n": len(rows), "errors": len(wrong), "fp": fp, "fn": len(wrong) - fp,
                                "errors_high_confidence": high, "errors_low_confidence": len(wrong) - high}
        md.append(f"| {SHORT[t]} | {len(wrong)} / {len(rows)} | {fp} | {len(wrong) - fp} | {high} | {len(wrong) - high} |")
        comp = {}
        for fid, label in DESCRIBE:
            right = [value(p, fid) for p, pred, y in rows if (pred["predicted_class"] == "positive") == (y == 1)]
            bad = [value(p, fid) for p, _, _ in wrong]
            comp[label] = {"correct": sum(right) / len(right), "misclassified": sum(bad) / len(bad) if bad else None}
        report["targets"][t]["profile"] = comp
    md += ["", "## Misclassified vs correctly classified (descriptive means / proportions)", ""]
    md += ["| Measurement | " + " | ".join(f"{SHORT[t]} correct | {SHORT[t]} wrong" for t in TARGETS) + " |",
           "|---|" + "---|" * 8]
    for _, label in DESCRIBE:
        cells = []
        for t in TARGETS:
            c = report["targets"][t]["profile"][label]
            fmt = (lambda v: "—" if v is None else f"{v:.1f}") if label in ("Age (y)", "EF (%)") else (
                lambda v: "—" if v is None else f"{100 * v:.0f}%")
            cells += [fmt(c["correct"]), fmt(c["misclassified"])]
        md.append(f"| {label} | " + " | ".join(cells) + " |")

    def first(pred) -> dict | None:
        return next((p for p in patients if pred(p)), None)

    cad = lambda p: p["bundle"]["targets"]["cad"]
    rules = [
        # Displayed HIGH, not merely inside the region: a gate (atypical, unstable) can downgrade a region case (audit R08).
        ("Correct, shown with HIGH confidence (CAD): lowest id displayed HIGH positive with CAD label = 1",
         lambda p: cad(p)["model_confidence"] == "high" and cad(p)["predicted_class"] == "positive"
         and p["truth"]["cad"] == 1, "cad"),
        ("Error shown with HIGH confidence (CAD): lowest id displayed HIGH positive with CAD label = 0",
         lambda p: cad(p)["model_confidence"] == "high" and cad(p)["predicted_class"] == "positive"
         and p["truth"]["cad"] == 0, "cad"),
        ("Near the operating threshold (LAD): smallest |p − t_op|", None, "lad"),
        ("Atypical profile: lowest id with the atypical flag", lambda p: p["bundle"]["quality"]["atypical_profile"]["flag"], "cad"),
    ]
    md += ["", "## Representative cases (rule-selected)", ""]
    for rule, pred, focus in rules:
        if pred is None:
            p = min(patients, key=lambda q: (abs(q["bundle"]["targets"]["lad"]["probability"]
                                                 - q["bundle"]["targets"]["lad"]["operating_threshold"]),
                                             q["bundle"]["patient_id"]))
        else:
            p = first(pred)
        if p is None:
            md += [f"**{rule}** — no patient meets this rule.", ""]
            continue
        case = summarize_case(p, rule, focus)
        report["representative_cases"].append(case)
        md += [f"### {case['patient_id']} — {rule}", "",
               "| Target | Probability | Predicted | Model confidence | Dataset label |", "|---|---|---|---|---|"]
        for t in TARGETS:
            x = case["predictions"][t]
            md.append(f"| {SHORT[t]} | {x['probability']:.2f} | {x['predicted']} | {x['confidence'].upper()} | "
                      f"{'positive' if x['label'] else 'negative'} |")
        if case["patient_id"] == "ZAS-0094":
            md += ["", ("**Note:** this is the D-001 record (source row 93): LAD = Stenotic but Cath = Normal in the "
                        "published labels, i.e. the CAD 'error' coincides with the one label discordance in the dataset.")]
        if case["atypical"]["flag"] and case["predictions"][focus]["confidence"] == "low":
            md += ["", "The atypical-profile flag forces LOW model confidence even inside a high-confidence region."]
        md += ["", f"Atypical profile: {'yes' if case['atypical']['flag'] else 'no'} "
                   f"(distance percentile {case['atypical']['distance_percentile']}). "
                   f"Top {SHORT[focus]} model contributions: " + "; ".join(case["top_contributions"]) + ".", ""]
    (ROOT / "results" / "error_analysis.json").write_text(json.dumps(report, indent=1), encoding="utf-8", newline="\n")
    (ROOT / "results" / "error_analysis.md").write_text("\n".join(md) + "\n", encoding="utf-8", newline="\n")
    print("results/error_analysis.md written")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
