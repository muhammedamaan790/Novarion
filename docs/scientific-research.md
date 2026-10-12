# Novarion: scientific audit and improvement research

Reviewed 11 October 2026. This report compares the implementation, the supplied Track A PDF and master plan, the actual checksum-verified UCI workbook, and primary research/documentation. The supplied plan is design background; its scope-freeze language does not override the user's request to investigate additional features.

## Finding in plain language

Keep the existing architecture. The four-target pipeline, fold-local preprocessing, model selection and additive explanations are substantial and mostly aligned with the brief. The important weaknesses are evidence provenance, calibration edge cases, stale training caches and the incomplete real-model integration. A prettier dashboard or a larger model will not resolve these weaknesses.

Several defects were reproduced and corrected in this branch. The trained weights and detailed fold outputs are absent from the checkout, so the old performance tables are **repository-reported results**, not independently reproduced measurements. The fixes do not improve or establish a new accuracy figure. A fresh training/bundle build and end-to-end real-model review remain necessary.

## 1. What the labels actually mean

UCI #411 contains 303 records and defines CAD through angiographic narrowing of at least 50%; the extension adds LAD, LCX and RCA labels. It requires exclusion of other angiographic targets from the predictors. These are diagnostic labels, not longitudinal heart-attack, mortality or ten-year risk outcomes. A stenosis-label probability of 80% does **not** mean 80% anatomical narrowing. [UCI dataset owner](https://archive.ics.uci.edu/dataset/411/extention+of+z+alizadeh+sani+dataset)

The original dataset paper introduces 303 patients and clinical diagnostic predictors. The later separate-artery paper reports 500 patients; its headline performance cannot be treated as a directly comparable benchmark for the supplied 303-row file. [Original dataset study](https://pubmed.ncbi.nlm.nih.gov/23537611/), [later extension study](https://pubmed.ncbi.nlm.nih.gov/29903478/)

The local workbook matches the pinned checksum. Loading the actual data gives:

| Item | Verified locally |
|---|---:|
| Patients / source columns / predictor columns | 303 / 59 / 55 |
| CAD positive | 216 |
| LAD positive | 177 |
| LCX positive | 119 |
| RCA positive | 114 |
| Overall CAD disagrees with any-positive-vessel rule | 1 record: source row 93 |

Preserving the discordant labels is reasonable; do not silently rewrite them or force the four independent predictions to nest. The registry excludes Cath/CAD/LAD/LCX/RCA, including derived-feature lineage. See [data loading and leakage checks](../ml/novarion_ml/data/load.py#L96) and [documented label decision](decisions.md#L9).

A separate documented boundary case is retained: zero-based record 153 (ZAS-0154) has source obesity=1 at BMI 25.0, while manual input computes obesity using BMI >25. The existing parity test explicitly records this one-row mismatch. Prefilling that record is consequently not guaranteed to preserve its source input hash or OOF provenance; do not claim universal exact parity. [Existing data decision D-002](decisions.md#d-002--computed-bmi-and-obesity-for-new-cases), [parity test](../tests/test_canonical.py#L28)

The current [wording](../frontend/src/components/wording.ts#L35) already distinguishes the hackathon's phrase "overall cardiac risk" from this dataset's CAD label. Preserve that honesty. The reference heart must remain an anatomical illustration: this dataset does not locate lesions, reconstruct the patient's arteries or measure patient-specific plaque. The official PDF explicitly cautions that RWMA values are not anatomical coordinates.

## 2. Confirmed defects and fixes

| Priority | Confirmed problem | Reproduction / consequence | Branch correction |
|---|---|---|---|
| P1 | Empty outer-validation confidence region aborts otherwise valid inference | A qualified LAD high-positive threshold with p=0.95, n_high_positive=0 and ppv=None raised ValueError; a four-target response consequently could fail | Preserve prediction and probability, downgrade confidence with `no_validation_evidence`, withhold PPV/NPV |
| P1 | OOF evidence ledger indirectly uses the held-out query label | For query in fold A, reference patient in fold B had an OOF score from a model trained on A. Band membership therefore could depend on the query's label | Save selected model's inner cross-fitted probabilities within each outer-training fold; build that fold's ledger only from those. Reject legacy fold caches lacking these scores |
| P1 | Stale fits can be stamped as current evaluation | Cache key omitted implementation code; evaluation never checked each cached record's key, identity or split labels | Fingerprint ML code, training driver and locked dependencies; verify fold provenance before writing results; reject stale final/evaluation/fold inputs before bundle assembly |
| P2 | Failed optimizer can be accepted as a valid Platt calibrator | Stubbed optimizer `success=False, x=[1,0]` yielded `Platt.valid=True` | Require successful optimization and finite parameters; invalid fits enter the existing candidate guard |
| P2 | Calibration slope reported despite complete/quasi separation | For z=[-2,-1,1,2], y=[0,0,1,1], old function returned slope 12.7555 although no finite free-slope MLE exists | Explicitly reject separation and constant-margin slope fits; report undefined slope as NA; retain separately identifiable calibration-in-the-large |

Implementation: [inference fallback](../ml/novarion_ml/inference/engine.py#L82), [calibration guards](../ml/novarion_ml/calibrate/platt.py#L45), [cache provenance](../scripts/train.py#L59), [outer-training score persistence](../ml/novarion_ml/train/nested.py#L153), [safe ledger assembly](../scripts/build_bundle.py#L77), [targeted regressions](../tests/test_ml_research_regressions.py).

SciPy exposes optimizer success explicitly; finite parameter output alone is insufficient. Separation can produce an apparently converged objective while parameter estimates have no finite maximum. [SciPy result contract](https://docs.scipy.org/doc/scipy/reference/generated/scipy.optimize.OptimizeResult.html), [statsmodels separation/convergence documentation](https://www.statsmodels.org/stable/pitfalls.html#incomplete-convergence-in-maximum-likelihood-estimation)

The ledger issue affects the **evidence band's descriptive label rate**, not the query's correctly held-out probability or fold-specific SHAP explanation. The correction excludes the query's entire outer-test fold from evidence fitting. The inner scores remain training-side descriptive evidence because their calibrator is fitted on outer-training labels; they are not a fresh independent validation study.

New bundles carry `oof_ledger_method: outer_training_inner_crossfit`. For previously built bundles, legacy OOF ledger rates should be withheld with a visible notice until regenerated; the core held-out predictions and additive explanations can remain available. For a genuinely new unseen patient, the final-model reference ledger uses global OOF scores from the training cohort and does not include that new patient's outcome. An exact training-profile match remains explicitly warned. Only the OOF patient's stored evidence ledger needs legacy withholding; production inference does not load fold models.

Validation completed for this research contribution: **33 targeted and existing ML-core tests passed**, and the affected Python files passed lint checks. No full model training was run. Full branch validation and browser checks are recorded by the broader audit.

## 3. What is already scientifically sound

- The outer-test fold does not choose a model, fit preprocessing, calibrate probabilities or choose thresholds. The code performs inner selection, training-side calibration and thresholding, then a single outer-test score. This is the appropriate separation for estimating the whole selection procedure. [Nested-CV implementation](../ml/novarion_ml/train/nested.py#L68), [scikit-learn nested-CV guidance](https://scikit-learn.org/stable/auto_examples/model_selection/plot_nested_cross_validation_iris.html)
- Scaling and zero-variance filtering are fold-local; published category sets are registry-defined rather than learned from test rows. [Encoder](../ml/novarion_ml/features/encoder.py#L52)
- Platt scaling acts affinely on the model's raw margin. Scaling additive feature contributions by its slope and shifting the base by its intercept preserves exact calibrated-logit additivity. The existing family tests check this arithmetic. [Attribution implementation](../ml/novarion_ml/inference/engine.py#L126), [family tests](../tests/test_ml_core.py#L68)
- Unknown inputs are explicitly imputed from the appropriate reference, labelled imputed and force LOW confidence. They are not silently portrayed as measurements. [Reference context](../ml/novarion_ml/uncertainty/reference.py#L146), [quality policy](../ml/novarion_ml/inference/engine.py#L67)
- No rule-out region is manufactured when pre-registered requirements cannot be met. Holding thresholds fixed after seeing results is preferable to tuning the demonstration on outer-test outcomes. [Threshold selection](../ml/novarion_ml/thresholds/layers.py#L88), [pre-registered presentation decision](decisions.md#L122)

## 4. Remaining limitations and improvements

### Evidence must match the policy users see

Table 2 currently uses the threshold region saved during outer evaluation. Serving additionally forces LOW when a profile is atypical against any target reference. Thus "threshold-qualified region" and "HIGH confidence displayed by the app" are different cohorts. This is a confirmed source mismatch; the numerical size of the discrepancy is unmeasured without fold artifacts. [Raw region scoring](../ml/novarion_ml/train/nested.py#L112), [Table 2 assembly](../scripts/train.py#L198), [serving quality gate](../ml/novarion_ml/inference/engine.py#L67)

Keep the original statistical table clearly labelled as **threshold-only**. After bundle regeneration, additionally report coverage/PPV/NPV after the exact app quality policy, using identical patient IDs and an explicit denominator. Do not attach the former cohort's PPV to a subgroup while implying it measures the latter. This requires artifact-backed recalculation; fabricating adjusted results would be worse than leaving it pending.

### Performance differs materially by target

The checked-in [tables](../results/tables.md#L7) report:

| Target | Outer-fold ROC-AUC mean ± SD | Accuracy | Prespecified repeat LOW-confidence share |
|---|---|---|---|
| CAD | 0.930 ± 0.035 | 85.6% | 38.3% |
| LAD | 0.838 ± 0.046 | 77.1% | 100% |
| LCX | 0.721 ± 0.067 | 65.2% | 100% |
| RCA | 0.736 ± 0.037 | 65.5% | 100% |

These are existing repo claims, not retraining results from this audit. Vessel models are weaker, particularly LCX/RCA; do not headline CAD AUC as the performance of all vessels. Probability, predicted class and evidence strength deserve separate labels. "LOW confidence" means the qualification policy was not met, not that the probability automatically equals 50%.

Calibration should be inspected with reliability plots and sample counts. Brier loss also reflects discrimination and outcome uncertainty; it alone cannot prove calibration. Calibrated probabilities are population-relative frequencies, not certainty about an individual. [Official calibration documentation](https://scikit-learn.org/stable/modules/calibration.html)

The existing fixed-score patient bootstrap intervals do not refit the learning procedure. They describe sampling variation conditional on these saved OOF outputs; they omit model-training/selection uncertainty and dependence caused by overlapping training folds. Repeated-fold SD is descriptive variability, not 25 independent experiments. Preserve the current table and disclose the interval construction. [Original methodological work on CV uncertainty](https://arxiv.org/abs/2104.00673)

### Internal evaluation is not external clinical validation

The 303-row diagnostic cohort cannot establish population-wide transportability or real-world benefit. External evaluation on a separate relevant cohort, complete recruitment/measurement provenance and an intended-use definition would be needed before clinical deployment. Do not treat software readiness as clinical validity. [TRIPOD+AI primary reporting guidance](https://www.bmj.com/content/385/bmj-2023-078378)

### Explanation does not establish treatment benefit

Correlated inputs may share attribution. Exact additive explanations show how the selected model uses supplied values; they do not establish what caused a patient's disease. A what-if edit is a model sensitivity experiment, not the expected effect of lowering cholesterol or changing treatment. Keep the existing noncausal caption, especially if scenario comparison is added. [SHAP authors' causal interpretation guidance](https://shap.readthedocs.io/en/latest/example_notebooks/overviews/Be%20careful%20when%20interpreting%20predictive%20models%20in%20search%20of%20causal%20insights.html)

### Input similarity needs missingness context

Gower similarity excludes unknown fields, but its atypical percentile is compared with a leave-one-out distribution built on complete reference profiles. With many unknowns, the distance uses a different feature subset, so that percentile is not directly comparable to complete-input percentiles. UNKNOWN already forces LOW; the remaining issue is explanatory clarity. Show how many fields informed a neighbour ranking, avoid asserting missingness itself demonstrates an in-cohort patient, and consider a reference distribution using the same missingness mask before introducing a strong percentile claim. [Distance implementation](../ml/novarion_ml/uncertainty/reference.py#L94)

## 5. New features genuinely absent from the supplied plan

The plan already specifies saved cases, imports, review snapshots, model evidence, reliability plots, attribution heatmaps, similar patients, actual-label reveal, what-if sensitivity, confidence stability, outcome capture and a governed learning loop. Those are unfinished planned work, not new ideas. The following additions were checked against the plan's feature tiers, evaluation, product workflow, differentiators and full-text searches.

| Rank | New feature | Why it adds value | Feasibility / boundary |
|---|---|---|---|
| 1 | **OOF failure explorer** | A target-specific TP/TN/FP/FN grid opens the complete relevant patient list, lets a reviewer inspect an incorrect case in 3D, and identifies which vessel failed | Medium; needs full OOF artifacts, no new model. The plan reports false-positive/negative counts and reveals labels, but has no linked misclassification browser. Use all cases in each category, not a cherry-picked success demo |
| 2 | **Subgroup performance explorer** | Compare age-band/sex-specific error counts, calibration and confidence coverage; show n and class balance before showing any metric | Medium; offline computation from fixed OOF records. The plan's small-subgroup guard applies to feature comparisons, not model-performance slices. Pre-register bins, suppress unsupported cells and call results exploratory; no claim of demographic fairness from 303 patients |
| 3 | **Human-first educational review** | Hide AI results while a learner records a provisional vessel assessment, then reveal the fixed OOF prediction, explanation and eventual label | Low-medium; extends existing review UI. The plan records review notes after AI analysis, not a blinded-before-reveal sequence. No clinician-performance, automation-bias reduction or treatment claims without a proper study |
| 4 | **Decision-utility research tab** | Compare OOF model net benefit with default strategies across explicitly hypothetical decision preferences | Medium; additional evaluation rather than new ML. Not present in plan's ROC/PR/calibration/threshold plots. Do this after core delivery; action/preference assumptions must be defined, and it must not recommend angiography or treatment thresholds |

The first two would make the submission more technically credible than another generic dashboard page. The third is attractive for a live educational demo. The fourth is a later research option: decision curves incorporate assumed false-positive/false-negative consequences, so AUC alone cannot answer the same question. [Original Vickers–Elkin decision-curve method](https://pubmed.ncbi.nlm.nih.gov/17099194/)

Do not add risk trajectories, plaque hotspots, patient-specific ECG/image interpretation, a chatbot that offers clinical recommendations, or automatically self-training models. The provided data do not support those claims, and the accepted plan already rejects trajectory/chatbot scope.

## 6. Recommended order

1. Land reproduced correctness fixes and ensure mock mode remains visibly synthetic.
2. Obtain the friend's complete trained outputs; existing scores stay marked unreplicated.
3. Refit using corrected calibration/cache code, regenerate safe ledgers and version the resulting bundle. Old weights do not become scientifically corrected by replacing Python source.
4. Verify all 303 OOF patient bundles and real new-case inference; check explanation sums, label identity, 3D target correspondence and explicit LOW-confidence handling.
5. Finish the already-planned evidence screen and case/review snapshot flow before adding new scope.
6. If time remains, implement the OOF failure explorer first, then subgroup evidence. Keep new features behind the same artifact-backed validation boundaries.

This research does not establish clinical efficacy, reproduce reported performance or certify patient-specific anatomy. It identifies concrete software defects, preserves the existing valid methodology, and provides a testable next contribution.
