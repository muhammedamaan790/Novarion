# Presentation notes (demo, video, judge Q&A)

Written **before** any real model results exist (D-008), so the wording cannot be tuned to the outcome.
Replace every `[ACTUAL …]` with the measured value from `results/`; never round in our favour.

## 1. If many predictions are LOW MODEL CONFIDENCE

**What we will not do:** lower the PPV/NPV targets, widen the regions, or pick demo patients by their confidence
tier (demo patients are fixed in `config/demo_config.yaml` before final predictions, plan §17).

**What we say (demo voice-over):**
> "Every vessel always gets a prediction: stenosis predicted or not. Separately, Novarion tells you whether that
> score falls in a region where, in validation, the model met a pre-registered accuracy target. For [LCX] it often
> doesn't, and the system says so instead of sounding sure. With 303 patients, refusing to overstate is the
> feature, not a failure."

**On screen:** the dashed, desaturated vessel + the reason ("near the decision threshold" / "no qualified
high-confidence region for this target"). Then show a HIGH vessel next to it so the contrast is visible.

**In the report (Table 2):** the share of HIGH-positive / HIGH-negative / LOW per target, with the measured PPV/NPV
of the HIGH regions `[ACTUAL]`. If a target has no qualified region at all, say it plainly: "the available features
do not separate this vessel well enough in this cohort to qualify a high-confidence region."

## 2. "Other teams report 90 %+ accuracy. Why are your numbers lower?"

> "Because ours are measured on patients the model never saw, at any step. Every number comes from nested
> cross-validation: the model, its hyperparameters, its calibration and its decision thresholds are all chosen
> inside the training folds only. Many published results on this dataset select features or tune on the full data,
> or report accuracy at a threshold picked on the test set, which inflates the number. On a cohort that is 71 %
> CAD-positive, 'always predict CAD' already scores 71 % accuracy, so we report accuracy next to that baseline, plus
> ROC-AUC, balanced accuracy and calibration. Our CAD ROC-AUC is `[ACTUAL]` (outer-fold mean ± SD); the vessel
> models are weaker (`[ACTUAL]`), which is an honest property of predicting vessel-level stenosis from routine
> clinical features."

Supporting evidence to have open: Table 1 (model vs always-negative / always-positive / prior baselines), the
nested-CV diagram, the leakage test list, the reliability plot.

**Short version (≤ 15 s):** "Ours are out-of-sample with nested CV, thresholds chosen without test data, and shown
next to the 71 % always-CAD baseline. Inflated numbers usually come from tuning on the test set."

## 3. Wording rules (always)

- "CAD probability", "LAD stenosis-label probability"; never "risk of disease", "diagnosis", "you have".
- "HIGH / LOW MODEL CONFIDENCE"; never bare HIGH/LOW; never "certainty".
- SHAP = "model contribution"; never "risk factor" or "cause".
- The disclaimer is visible in every frame of the video (persistent banner) and spoken at the start and end.
