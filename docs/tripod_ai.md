# TRIPOD+AI reporting checklist

NOVARION reported against **TRIPOD+AI**, the reporting guideline for clinical prediction models that use regression
or machine learning (Collins et al., *BMJ* 2024;385:e078378). An umbrella review of AI for cardiovascular risk
prediction (Parizad et al., *Vasc Health Risk Manag* 2026) names incomplete reporting as a main barrier to clinical
translation. The items below are grouped by the guideline's sections and paraphrased; see the guideline for the exact
item wording.

**Status key**
- **Reported**: the item is covered, at the location given.
- **Partly**: the item is covered with a stated limitation.
- **Not applicable**: the item does not apply to this project.
- **Gap**: the item is not covered (stated honestly).

## Title and abstract

| Item | Status | Where |
|---|---|---|
| Identify the study as developing and evaluating a prediction model, the target population and the outcomes | Reported | `docs/report.pdf` (title, §1) and `docs/model_card.md` |
| Structured summary | Partly | The report's §1 and the README summarise the work; there is no formal structured abstract |

## Introduction

| Item | Status | Where |
|---|---|---|
| Medical context, rationale and existing models | Reported | Report §1. The guideline pretest score (updated Diamond–Forrester) is the comparator in Table 6 |
| Objectives: development and internal validation, intended use and users | Reported | Model card ("Intended use", "Out of scope") and the persistent disclaimer |
| Health inequalities by sex or age | Partly | Subgroup performance by sex and age (Table 7) is reported descriptively; the cohort is too small for fairness claims |

## Methods

| Item | Status | Where |
|---|---|---|
| Data source, setting, dates | Reported | UCI #411 (Extension of Z-Alizadeh Sani), one centre, checksum-pinned (`config/data_source.json`, D-001). The public record gives no dates |
| Eligibility criteria and treatments | Partly | As published with the dataset; the participants are patients referred for angiography |
| Data preparation and quality checks | Reported | `data/schema_report.json`, `config/feature_registry.yaml` (units, valid ranges, encodings), and leakage tests |
| Outcome definition and how it was assessed | Reported | `config/targets.yaml`: the dataset's angiographic labels (CAD per Cath; ≥ 50% stenosis per vessel). There is no assessor blinding information |
| Predictors: definition, measurement, timing | Partly | Feature registry: definitions, units, valid ranges. Label columns are excluded by a lineage-aware guard (`tests/test_leakage.py`). Not established by the source: when each predictor was measured relative to angiography, and whether assessors were blinded to it. This is a reporting gap, not evidence of leakage |
| Sample size | Partly | Fixed by the dataset (303; 216 CAD). Events per class are reported, and nested CV with bootstrap CIs makes the uncertainty explicit. No a-priori sample-size calculation |
| Missing data | Reported | None in the source. Explicit UNKNOWN for new cases: imputed from the training fold only and forces LOW confidence |
| Analytical methods: model types, tuning, selection | Reported | Nested CV (5 × 5 outer, 5 inner), 92 pre-registered configurations, 1-SE rule (`config/train.yaml`, report §3, D-009) |
| Class imbalance | Reported | Class weighting is part of the pre-registered grid; Platt calibration is on cross-fitted scores |
| Fairness approach | Partly | Subgroup discrimination and calibration by sex and age (Table 7); no mitigation was attempted |
| Model output and its meaning | Reported | A calibrated probability plus a binary call at t_op, and a confidence tier with stated reasons (report §3, D-008) |
| Training versus evaluation data | Reported | Outer folds only for evaluation; dataset patients are shown with their out-of-fold model (D-009). Fold-safe evidence ledgers (D-019) |
| Performance measures and their rationale | Reported | Discrimination, calibration (slope, intercept, calibration-in-the-large, ECE, reliability), Brier, PPV/NPV with CIs, NRI/IDI and net benefit (Tables 1, 2, 2b, 6, 8) |
| Model updating | Reported | Governed learning loop with a pre-registered gate and human approval (D-018); nothing updates automatically |
| Ethics | Reported | Public, de-identified dataset (CC BY 4.0); no new data collection |

## Open science

| Item | Status | Where |
|---|---|---|
| Funding and conflicts of interest | Reported | Hackathon project, no funding, no conflicts |
| Protocol | Partly | A pre-registered design (configs written before results: D-008, `promotion_gate.yaml`, `replay.yaml`), not published externally |
| Registration | Gap | Not registered |
| Data sharing | Reported | Public dataset, with a download and checksum script |
| Code sharing | Reported | Full repository, with `make reproduce` verified exact on a fresh clone (`results/reproduction.json`) |

## Patient and public involvement

| Item | Status | Where |
|---|---|---|
| Patient and public involvement | Gap | None |

## Results

| Item | Status | Where |
|---|---|---|
| Participant flow and characteristics | Reported | `results/eda.md` (prevalence per target, sex share, age summary) and per-subgroup counts in Table 7 |
| Model development details | Reported | Selected families across folds (Table 3), deployed configurations (model card) |
| Model specification for use | Reported | Versioned, hash-verified bundle; the API contract (`contracts/openapi.json`) |
| Performance with CIs, including subgroups | Reported | Tables 1, 2, 2b, 6 and 7; the label-permutation test (Table 1b) |
| Comparison with an existing model | Reported | Table 6: CAD AUC 0.935 vs 0.852 for updated Diamond–Forrester (ΔAUC +0.083 [0.042, 0.127]) |
| Model updating results | Reported | Historical replay (research demonstration, not temporal validation; D-018) |

## Discussion

| Item | Status | Where |
|---|---|---|
| Interpretation, including fairness | Reported | Report §4 and §7. Weaker in patients aged 65 and over (Table 7) |
| Limitations | Reported | One centre, 303 patients, high prevalence, internal validation only, associations not causes |
| Usability in context, and the user interface | Reported | Report §5: case workflow, explanation, safety wording, no recommendations |
| Next steps | Reported | External validation is the necessary next step before any clinical use |

**Main gaps, stated plainly:**
- no external or temporal validation;
- no registration;
- no patient and public involvement;
- a small, single-centre, high-prevalence cohort.

NOVARION is a decision-support and educational prototype, not a clinical tool.
