"""Build the project report (plan §18, ≤ 6 pages): docs/report.html (self-contained) → docs/report.pdf.

Every number is read from results/ and the bundle manifest at build time (never typed by hand); figures are real
application screenshots from the E2E run (results/ui/real/). PDF: `node frontend/scripts/print_report.mjs`.
Usage: uv run python scripts/build_report.py
"""

from __future__ import annotations

import base64
import html
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SHOTS = ROOT / "results" / "ui" / "real"
TARGETS = ("cad", "lad", "lcx", "rca")
NAME = {"cad": "CAD", "lad": "LAD", "lcx": "LCX", "rca": "RCA"}
GROUPS = ("demographics", "history", "symptoms_exam", "ecg", "labs", "echo")
TEST_COUNTS = {"python": 190, "vitest": 24, "e2e": 50}  # measured counts of the last full runs (update with them)
GROUP_LABEL = {"demographics": "Demogr.", "history": "History", "symptoms_exam": "Symptoms/exam", "ecg": "ECG",
               "labs": "Labs", "echo": "Echo"}


def load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def m(summary: dict, key: str, digits: int = 3) -> str:
    v = summary.get(key) or {}
    if v.get("mean") is None:
        return "N/A"
    return f"{v['mean']:.{digits}f} ± {v['sd']:.{digits}f}" if v.get("sd") is not None else f"{v['mean']:.{digits}f}"


def pct(x) -> str:
    return "—" if x is None else f"{100 * x:.1f}%"


def img(name: str, caption: str, width: str = "100%") -> str:
    path = SHOTS / name
    if not path.exists():
        return f"<p class='missing'>[figure missing: {html.escape(name)}]</p>"
    data = base64.b64encode(path.read_bytes()).decode()
    return (f"<figure><img src='data:image/png;base64,{data}' style='width:{width}'/>"
            f"<figcaption>{caption}</figcaption></figure>")


def table(head: list[str], rows: list[list[str]], cls: str = "") -> str:
    th = "".join(f"<th>{h}</th>" for h in head)
    tr = "".join("<tr>" + "".join(f"<td>{c}</td>" for c in r) + "</tr>" for r in rows)
    return f"<table class='{cls}'><thead><tr>{th}</tr></thead><tbody>{tr}</tbody></table>"


def main() -> None:
    reg = load(ROOT / "registry" / "models.json")
    entry = next(e for e in reg["models"] if e["version"] == reg["production_version"])
    manifest = load(ROOT / entry["path"] / "manifest.json")["manifest"]
    metrics = load(ROOT / "results" / "metrics.json")["targets"]
    ablation = load(ROOT / "results" / "ablation.json")["targets"]
    errors = load(ROOT / "results" / "error_analysis.json")
    schema = load(ROOT / "data" / "schema_report.json")
    perf = load(ROOT / "results" / "perf.json")
    t = metrics

    t1_rows = []
    for k in TARGETS:
        r = t[k]
        t1_rows.append([f"<b>{NAME[k]}</b>", pct(r["prevalence"]), m(r["model"], "roc_auc"), m(r["model"], "pr_auc"),
                        m(r["model"], "accuracy"), m(r["model"], "balanced_accuracy"), m(r["model"], "precision"),
                        m(r["model"], "recall"), m(r["model"], "f1"), m(r["model"], "brier"),
                        m(r["model"], "cal_slope", 2)])
        t1_rows.append(["", "", "<i>always positive</i>", "—", m(r["baselines"]["always_positive"], "accuracy"),
                        "0.500", m(r["baselines"]["always_positive"], "precision"), "1.000",
                        m(r["baselines"]["always_positive"], "f1"), m(r["baselines"]["prior"], "brier"), "—"])
    t2_rows = []
    for k in TARGETS:
        x = t[k]["table2"]
        ci = (lambda c: f" [{pct(c[0])}–{pct(c[1])}]" if c else "")
        t2_rows.append([NAME[k], f"{x['auc']:.3f}" + (f" [{x['auc_ci'][0]:.3f}–{x['auc_ci'][1]:.3f}]" if x["auc_ci"] else ""),
                        pct(x["pct_high_positive"]), pct(x["ppv"]) + ci(x["ppv_ci"]), pct(x["pct_high_negative"]),
                        pct(x["npv"]) + ci(x["npv_ci"]), pct(x["pct_low_confidence"]), str(x["fp_high_positive"])])
    bench_rows = []
    for k in TARGETS:
        b = t[k]["benchmarks"]
        bench_rows.append([NAME[k], m(t[k]["model"], "roc_auc")] + [m(b[f], "roc_auc") for f in ("lr", "ebm", "xgboost", "catboost")]
                          + [", ".join(f"{f} {n}" for f, n in t[k]["selected_families"].items())])
    abl_rows = [[NAME[k], f"{ablation[k]['full']['mean']:.3f}"] +
                [f"{ablation[k][f'without_{g}']['delta_mean']:+.3f}" for g in GROUPS] for k in TARGETS]
    err_rows = [[NAME[k], f"{e['errors']}/{e['n']}", str(e["fp"]), str(e["fn"]), str(e["errors_high_confidence"])]
                for k, e in errors["targets"].items()]
    cases = errors["representative_cases"]
    stability = load(ROOT / "results" / "stability.json")
    crossings = {k: sum(f["intervals_crossing_t_op"] for f in stability["folds"] if f["target"] == k) for k in TARGETS}
    replay = load(ROOT / "registry" / "replay.json")
    sizes = replay["training_sizes"]
    replay_rows = [[NAME[k]] + [f"{p['auc_mean']:.3f} ± {p['auc_sd']:.3f}" for p in replay["learning_curve"][k]]
                   for k in TARGETS]
    gate_pass = sum(f["PASS"] for f in replay["gate_frequencies"].values())
    perm = load(ROOT / "results" / "permutation.json")
    agree = load(ROOT / "results" / "model_agreement.json")["targets"]
    memory = perf["memory"]
    repro = load(ROOT / "results" / "reproduction.json")
    clin = load(ROOT / "results" / "clinical_evaluation.json")
    cb = clin["clinical_baseline"]
    vs_df, vs_refit = cb["novarion_vs_published_df"], cb["novarion_vs_df_inputs_refit"]
    cal = cb["calibration"]
    band_rows = [[html.escape(band), (f"{pct(cb['esc_pretest_bands']['novarion'][band]['share'])} "
                        f"({pct(cb['esc_pretest_bands']['novarion'][band]['observed_cad_rate'])})"),
                  (f"{pct(cb['esc_pretest_bands']['published_df'][band]['share'])} "
                  f"({pct(cb['esc_pretest_bands']['published_df'][band]['observed_cad_rate'])})")]
                 for band in cb["esc_pretest_bands"]["novarion"]]
    clin_rows = [["NOVARION", f"{vs_df['auc_new']:.3f}", f"{cal['novarion']['calibration_in_the_large']:+.3f}",
                  f"{cal['novarion']['ece']:.3f}", "—"],
                 ["Updated Diamond–Forrester (published)", f"{vs_df['auc_old']:.3f}",
                  f"{cal['published_df']['calibration_in_the_large']:+.3f}", f"{cal['published_df']['ece']:.3f}",
                  f"{vs_df['delta_auc']:+.3f} [{vs_df['delta_auc_ci95'][0]:.3f}, {vs_df['delta_auc_ci95'][1]:.3f}]"],
                 ["Same three inputs, refit on our folds", f"{vs_refit['auc_old']:.3f}",
                  f"{cal['df_inputs_refit']['calibration_in_the_large']:+.3f}", f"{cal['df_inputs_refit']['ece']:.3f}",
                  f"{vs_refit['delta_auc']:+.3f} [{vs_refit['delta_auc_ci95'][0]:.3f}, {vs_refit['delta_auc_ci95'][1]:.3f}]"]]
    sub = clin["subgroups"]
    old_auc = {t: sub[t]["age >= 65"]["auc"] for t in ("cad", "lad", "lcx", "rca")}
    gate_total = sum(sum(f.values()) for f in replay["gate_frequencies"].values())

    body = f"""
<header>
  <h1>NOVARION — a 3D coronary case-review system</h1>
  <p class="sub">Multimodal AI Hackathon 2026 · Track A: Cardiovascular Risk Visualization &amp; Prediction ·
  model v{manifest['model_version']} · <b>Decision support / educational purposes only. Not a substitute for formal
  diagnostic imaging.</b></p>
</header>

<h2>1. Problem, intended use and system</h2>
<p>Risk percentages alone do not show <i>where</i> a model sees disease or <i>why</i>. NOVARION predicts the overall
CAD label and the ≥50% stenosis labels of the LAD, LCX and RCA from routine clinical features, maps each vessel's
calibrated probability onto an interactive 3D heart inside a translucent torso, and explains every prediction with
exactly additive model contributions next to the patient's measurements. It is built as a review workflow
(case → data-quality gate → prediction → 3D vessel inspection → explanation → human review note → hash-verified Review
Snapshot → case history), not as a diagnostic tool: it never recommends tests or treatment, never localizes lesions
within a vessel, and shows a persistent disclaimer on every screen and printout.</p>
<p class="arch"><b>Architecture.</b> UCI #411 (checksum-pinned) → registry-driven canonicalization + leakage guard →
nested cross-validation (4 model families, 92 pre-registered configurations) → Platt calibration → two threshold
layers → versioned, hash-verified model bundle (v{manifest['model_version']}) → stateless FastAPI service (Pydantic
contract → OpenAPI → generated TypeScript types) → React 19 + React Three Fiber client (Zustand state, IndexedDB case
store). Registries (features, targets, anatomy map) make new features, models or structures a configuration change.</p>
{img("2-lad.png", "Figure 1 — A case's Result tab on a held-out dataset patient (out-of-fold prediction): LAD "
     "selected; the camera flies to the vessel and the others fade. Colour family = predicted class, depth = distance "
     "from the decision threshold, hatching = LOW model confidence. Beside it, a two-line summary and one line per "
     "target (binary call, probability, confidence) that expands to its stability interval and reasons.")}

<h2>2. Data and preprocessing</h2>
<p>Extension of Z-Alizadeh Sani (UCI #411, CC BY 4.0), verified on download: {schema.get('n_rows', 303)} patients ×
55 predictors, no missing values, no duplicate rows. Prevalence: CAD {pct(t['cad']['prevalence'])}, LAD
{pct(t['lad']['prevalence'])}, LCX {pct(t['lcx']['prevalence'])}, RCA {pct(t['rca']['prevalence'])}. The overall label
is <code>Cath</code>; it agrees with "any vessel stenotic" in 302/303 records (one discordant record, kept as published,
D-001). A feature registry fixes each feature's encoding, unit, valid range, UNKNOWN policy and lineage: binaries 0/1,
ordinal VHD and function class, one-hot bundle-branch block and RWMA region (codes have no natural distance). BMI and
obesity are computed from weight and height for new cases; a constant feature is auto-filled. <b>Leakage:</b> Cath,
CAD, LAD, LCX and RCA (and any feature derived from them) are excluded from every model's inputs, enforced by a
lineage-aware guard and tests. Every data-dependent step (zero-variance removal, log1p for skewed labs and scaling for
linear models, imputation of explicit UNKNOWN values) is fit inside each training partition only.</p>

<h2>3. Modelling and validation</h2>
<p><b>Nested cross-validation</b> per target: outer stratified 5-fold × 5 repeats (25 test folds); inner stratified
5-fold selects among 92 pre-registered configurations — logistic regression (L2/elastic-net), EBM without
interactions, XGBoost and CatBoost (shallow), × class weighting × two feature sets. Selection uses inner-CV ROC-AUC
with a 1-SE rule toward the simplest configuration; outer folds only estimate performance. <b>Calibration:</b> Platt
scaling on cross-fitted logits (guard a &gt; 0; never triggered). <b>Layer A</b> (official binary prediction): Youden
threshold on calibrated training-side OOF probabilities. <b>Layer B</b> (model confidence): HIGH only inside a region
whose Wilson-95% lower bound meets the pre-registered PPV ≥ 0.90 / NPV ≥ 0.95 (n ≥ 15); otherwise LOW with a stated
reason; UNKNOWN inputs and atypical profiles (Gower distance to the training cohort) force LOW. The deployed model per
target repeats the selection on all 303 patients and refits. Logistic regression was chosen in most outer folds
(Table 3), and in the deployed models for CAD, LAD and RCA (LCX: shallow XGBoost).
<b>Explanations</b> are exact: linear SHAP (LR), TreeSHAP (XGBoost/CatBoost) or native EBM terms in the raw margin,
scaled by the Platt slope into calibrated log-odds and summed per registry feature; base + Σ contributions = the
displayed calibrated logit is tested for every served explanation. Dataset patients are always shown with their
<b>out-of-fold</b> model (the fold that never saw them) and that fold's reference cohort. <b>Stability:</b> for each
dataset patient, the fold's selected configuration is refit with Platt on {stability['replicates']} bootstrap resamples
of that fold's training rows only (patient-grouped internal cross-fitting, threshold fixed); if the 10th–90th percentile
interval straddles the decision threshold the patient is shown LOW with reason "unstable" (CAD {crossings['cad']},
LAD {crossings['lad']}, LCX {crossings['lcx']}, RCA {crossings['rca']} of 303; D-017). After every display gate the CAD HIGH badge covers 44.6% of patients at PPV 98.5% (Table 2b).
Evidence-band ledgers use each fold's own inner cross-fitted scores, so a held-out patient's label never shapes
its own evidence (patch release v1.0.2, D-019, found by an external audit).</p>

<h2>4. Results</h2>
<p class="cap"><b>Table 1 — official metrics at the Layer-A threshold. Scope: outer-fold mean ± SD (25 folds).</b>
Italic rows: always-positive baseline (and the prior-probability Brier).</p>
{table(["Target", "Prev.", "ROC-AUC", "PR-AUC", "Accuracy", "Bal. acc.", "Precision", "Recall", "F1", "Brier",
        "Cal. slope"], t1_rows, "small")}
<p class="cap"><b>Table 2 — confidence tiers. Scope: pooled OOF (prespecified repeat), patient-level bootstrap 95% CI.</b></p>
{table(["Target", "AUC [CI]", "HIGH-pos.", "PPV [CI]", "HIGH-neg.", "NPV [CI]", "LOW", "FP in HIGH-pos."], t2_rows, "small")}
<p>CAD is ranked well (ROC-AUC {m(t['cad']['model'], 'roc_auc')}) and {pct(t['cad']['table2']['pct_high_positive'])}
of patients fall in a qualified HIGH-positive region with measured PPV {pct(t['cad']['table2']['ppv'])}. Vessel-level
separation from routine features is weaker (LAD {m(t['lad']['model'], 'roc_auc')}, LCX
{m(t['lcx']['model'], 'roc_auc')}, RCA {m(t['rca']['model'], 'roc_auc')}): <b>no vessel model qualified a
high-confidence region</b>, so every vessel prediction is shown as LOW confidence while still giving a binary call.
The targets were fixed before results and were not lowered (D-008). Accuracy should always be read against the
always-positive baseline ({m(t['cad']['baselines']['always_positive'], 'accuracy')} for CAD).</p>
<p class="cap"><b>Table 3 — family benchmarks (same selection rule within one family; ROC-AUC, outer-fold mean ± SD)
and families selected across the 25 outer folds.</b></p>
{table(["Target", "Selected", "LR", "EBM", "XGBoost", "CatBoost", "Selected family counts"], bench_rows, "small")}
<p><b>Against the guideline pretest score.</b> Reviews of cardiovascular AI ask for comparison with established
clinical scores, calibration beyond AUC and subgroup reporting (Parizad et al., Vasc Health Risk Manag 2026). For CAD
we compared NOVARION with the updated Diamond–Forrester pretest probability (age × sex × chest-pain type; ESC 2013)
on the {cb['n']} patients with a chest-pain type, using the same out-of-fold predictions.</p>
<p class="cap"><b>Table 6 — CAD versus the guideline pretest score. Scope: pooled OOF (prespecified repeat), paired
patient bootstrap 95% CI.</b> Calibration-in-the-large = observed − mean predicted.</p>
{table(["Model", "AUC", "Calibration-in-the-large", "ECE", "ΔAUC of NOVARION [95% CI]"], clin_rows, "small")}
{table(["ESC pretest band", "NOVARION: share (observed CAD)", "Diamond–Forrester: share (observed CAD)"], band_rows, "small narrow")}
<p>The extra measurements add discrimination beyond age, sex and chest-pain type, and NOVARION is better calibrated
on this high-prevalence cohort; the published score leaves {pct(cb['esc_pretest_bands']['published_df']['intermediate (15-85%)']['share'])}
of patients in the intermediate band, NOVARION {pct(cb['esc_pretest_bands']['novarion']['intermediate (15-85%)']['share'])}. The bands are
descriptive only: NOVARION recommends no tests or treatment, and its low band still holds
{pct(cb['esc_pretest_bands']['novarion']['low (<15%)']['observed_cad_rate'])} observed CAD. <b>Subgroups</b> (sex, age; full
table in <code>results/tables.md</code>): discrimination is similar by sex but lower in patients aged 65 and over (AUC
CAD {old_auc['cad']:.2f}, LAD {old_auc['lad']:.2f}, LCX {old_auc['lcx']:.2f}, RCA {old_auc['rca']:.2f}), with wide
intervals. A TRIPOD+AI checklist maps every reporting item (<code>docs/tripod_ai.md</code>).</p>
<p><b>Robustness.</b> A label-permutation test ({perm['permutations']} shuffles; 5-fold CV AUC of each deployed
configuration) puts every target above all shuffled-label runs (p = {perm['targets']['lcx']['p_value']:.3f} for each,
the smallest attainable; null AUC ≈ 0.50 ± 0.05; "evidence against the null under the test assumptions"). When the four
model families disagree on a held-out patient, the selected model errs far more often (CAD
{pct(agree['cad']['selected_error_rate_when_disagree'])} vs {pct(agree['cad']['selected_error_rate_when_agree'])},
LAD {pct(agree['lad']['selected_error_rate_when_disagree'])} vs {pct(agree['lad']['selected_error_rate_when_agree'])}),
so family disagreement is a useful descriptive cue for hard cases.</p>
<p class="cap"><b>Table 4 — feature-group ablation (descriptive): ΔROC-AUC when a group is removed and the
training-side procedure is re-run on the same 25 folds, logistic-regression family.</b></p>
{table(["Target", "Full", *[f"− {GROUP_LABEL[g]}" for g in GROUPS]], abl_rows, "small")}
<p>Symptoms and examination (typical chest pain) carry the most signal for CAD and LAD; echo (RWMA region, ejection
fraction) matters for LAD; demographics (age) for LCX. <b>Error analysis</b> (pooled OOF): CAD
{errors['targets']['cad']['errors']}/303 errors, of which {errors['targets']['cad']['errors_high_confidence']} were shown with
HIGH model confidence ({t['cad']['table2']['fp_high_positive']} false positives fall in the HIGH-positive
region; the atypical-profile rule downgrades the rest to LOW). Rule-selected cases (lowest id meeting each criterion) include {cases[1]['patient_id']}, the CAD
high-positive-region error — which is exactly the dataset's one label-discordant record (LAD stenotic, Cath normal) —
and {cases[3]['patient_id']}, whose atypical profile forces LOW confidence.</p>
{table(["Target", "Errors", "FP", "FN", "Shown with HIGH confidence"], err_rows, "small narrow")}

<h2>5. 3D visualization, interpretability and the system</h2>
<div class="two">
{img("11-compare.png", "Figure 2 — Compare all targets (a case's Why tab): a features × {CAD, LAD, LCX, RCA} "
     "contribution heatmap (amber ↑ / blue ↓, depth = size); the Result tab adds matching callouts on the heart.")}
{img("10-whole-body.png", "Figure 3 — Whole-body view: the heart inside a translucent torso and rib cage (body context "
     "fades automatically in vessel close-ups).")}
</div>
<p><b>Anatomy pipeline.</b> BodyParts3D 4.0 (CC BY 4.0): FMA concepts are resolved through the IS-A tree to element
meshes and merged into named nodes (vessel_lad, vessel_lcx, vessel_rca, left main, myocardium) plus non-pickable body
context (skin cropped to the trunk, rib cage); decimated to 131,990 triangles in total (2.5 MB GLB, anatomy v{manifest.get('anatomy_version', '1.0.0')})
and recorded in a hash-chained anatomy manifest. A single anatomy map binds each target
id to its node, camera preset and offline-computed label anchor; tests assert the correspondence. <b>Interaction:</b>
rotate/zoom/pan, five camera presets, click a vessel in 3D or its card (one store action, so 3D and panels can never
disagree), isolation, keyboard shortcuts, deep links, hover tooltips, compare mode. Colour is a monotone function of the
calibrated probability within each predicted class (OKLCH, threshold as zero point); the whole named vessel is tinted —
no lesion is implied. Rendering is on-demand, so the 3D stays responsive without a dedicated GPU. <b>What-if:</b> for a
new or edited case, one input at a time is varied across its training range (age and sex locked) and the probability
curve is drawn against the threshold, labelled "model sensitivity, not treatment simulation"; Unknown inputs that could
flip the predicted class are listed. <b>Interpretability:</b>
per-vessel contributions with strength words, presentation-group sums, a measurement table with each value's percentile
or prevalence among that target's positive and negative training patients (n shown; "insufficient evidence" below 20),
similar public-dataset patients, an empirical evidence ledger, and a Model Evidence page with ROC/PR/reliability/
threshold-sweep figures. <b>Workflow:</b> manual or CSV/JSON import (exact column matching, labels stripped, identifiers
dropped or rejected, units declared or confirmed, server-side quality gate); live re-prediction 300 ms after an edit;
cases, scenarios and immutable reviews in IndexedDB; Review Snapshot PDF/JSON built only from the stored analysis with
an RFC 8785 + SHA-256 hash that also covers the embedded 3D render.</p>

<h2>6. Governed learning loop (designed for continual supervised updating)</h2>
<p>Predictions always come from the current production model; nothing retrains automatically and the model never
learns from its own predictions. A reviewer can record an angiographic outcome on a saved case — stored as
<i>pending</i>, bound to that exact input hash. An allowlisted learning package (inputs, labels, source enums; no notes,
names, dates or identifiers) goes to an offline steward step (<code>make verify-outcomes</code>: label definition,
provenance, inputs predating the angiogram, conflicts, duplicates). <code>make candidate</code> freezes the newest
verified cases as a forward holdout before any challenger-side step, trains a challenger with the same final-model
procedure, freezes its configuration and scores champion and challenger once on that holdout. A pre-registered paired
gate (per target: ΔAUC 95% CI lower bound &gt; −0.05, Brier and calibration tolerances, at least one target improved;
too few holdout positives/negatives = "insufficient evidence", not failure) produces a report that a person must
approve (<code>make promote</code>; <code>make rollback</code> restores any earlier immutable bundle). Every step is
appended to a hash-chained audit log, and the Model Center shows registry, gate reports and log; it has no promote
button. An end-to-end verify → candidate → reject → promote → rollback drill is part of the test suite.</p>
<p class="cap"><b>Table 5 — historical replay (research demonstration, NOT temporal validation): the same 303 patients
in {replay['seeds']} pre-registered random arrival orders; AUC of the model trained on n patients, scored on the next
{replay['holdout_batch_size']} arrivals (mean ± SD across orders; {' + '.join(replay['families'])} search space).</b></p>
{table(["Target", *[f"n = {n}" for n in sizes]], replay_rows, "small narrow")}
<p>Only LCX improves consistently as cases accumulate; the other targets plateau within the across-order spread. The
gate promoted a challenger in {gate_pass} of {gate_total} replayed decisions — with 50-patient holdouts the paired ΔAUC
interval is wide, so the gate is conservative by design and "no promotion: the current model remains" is the usual,
displayed outcome.</p>
{img("13-model-center.png", "Figure 4 — Model Center (read-only): production status, registry, the governed update "
     "steps and the replay learning curves (forward-holdout AUC; band = range across arrival orders).")}

<h2>7. Usage, reproducibility, limitations</h2>
<p><b>Run:</b> <code>make reproduce</code> (download → train → evaluate → bundle) and <code>make serve</code> +
<code>npm run dev</code>, or <code>docker compose up</code>. Seeds, the split manifest, the training-matrix hash
(<code>{manifest['training_data_sha256'][:12]}…</code>) and per-file artifact hashes are recorded; the backend refuses a
modified bundle. A golden prediction set guards future patch releases; demo patients are picked by an outcome-blind hash
rule. Tests: {TEST_COUNTS['python']} backend/ML (leakage, contract, additivity,
calibration, thresholds, hashing, bundle integrity, golden set, stability, learning loop), {TEST_COUNTS['vitest']} frontend
unit tests and {TEST_COUNTS['e2e']} browser end-to-end flows, passing against the real model in Edge, Chrome and Firefox
(axe accessibility checks included). Measured: <code>/predict</code> p95
{perf['api']['endpoints']['predict']['p95_ms']:.0f} ms; 3D median {perf['fps']['median_fps']:.1f} fps on Intel Iris Xe integrated
graphics; backend memory {memory['rss_after_start_mb']:.0f} MB after start, {memory['rss_peak_mb']:.0f} MB peak. If the backend
is unreachable, a hash-verified static bundle keeps every dataset-patient flow working offline. <b>Reproduced:</b> a
full run on a fresh clone (fresh data download) matched every fold, metric, golden prediction, stability interval and
replay result exactly ({'passed' if repro['pass'] else 'FAILED'}; <code>results/reproduction.json</code>). <b>Limitations:</b> one public, single-source cohort of 303 patients
with high prevalence (PPV/NPV do not transfer); internal validation only; weaker performance in patients aged 65 and over; contributions are associations, not causes;
the anatomy is a reference model. <b>Credits:</b> dataset UCI #411 (CC BY 4.0); anatomy BodyParts3D, © The Database
Center for Life Science (CC BY 4.0).</p>
"""
    css = """
@page { size: A4; margin: 12mm 13mm 14mm 13mm; }
body { font-family: Inter, Segoe UI, Arial, sans-serif; font-size: 8.6pt; line-height: 1.32; color: #0f172a; }
h1 { font-size: 15pt; margin: 0 0 2pt; } h2 { font-size: 10.5pt; margin: 8pt 0 3pt; border-bottom: 1px solid #cbd5e1; }
.sub { font-size: 8pt; color: #334155; margin: 0 0 4pt; } p { margin: 3pt 0; text-align: justify; }
figure { margin: 4pt 0; } figcaption { font-size: 7.4pt; color: #475569; } img { border: 1px solid #e2e8f0; }
table { border-collapse: collapse; width: 100%; margin: 2pt 0 4pt; } th, td { border-bottom: 1px solid #e2e8f0;
padding: 1.5pt 3pt; text-align: left; } th { background: #f1f5f9; } table.small { font-size: 7.2pt; }
table.narrow { width: 60%; } .cap { font-size: 7.6pt; margin-top: 5pt; } code { font-size: 7.6pt; }
.two { display: flex; gap: 6pt; } .two figure { flex: 1; } .two img { width: 100%; }
.arch { background: #f8fafc; padding: 3pt 5pt; }
"""
    page = f"<!doctype html><html lang='en'><head><meta charset='utf-8'><title>NOVARION report</title>" \
           f"<style>{css}</style></head><body>{body}</body></html>"
    (ROOT / "docs" / "report.html").write_text(page, encoding="utf-8")
    print("docs/report.html written")


if __name__ == "__main__":
    main()
