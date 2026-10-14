# Presentation notes (demo, video, judge Q&A)

Written **before** any real model results exist (D-008), so the wording cannot be tuned to the outcome.
Replace every `[ACTUAL …]` with the measured value from `results/`; never round in our favour.

## 1. If many predictions are OUTSIDE QUALIFIED RANGE

(The app labels the two tiers **HIGH SUPPORT · INTERNAL EVALUATION** and **OUTSIDE QUALIFIED RANGE** (D-024, reworded
after audit R12); the report and model card call them HIGH and LOW.)

**What we will not do:** lower the PPV/NPV targets, widen the regions, or pick demo patients by their confidence
tier (demo patients are fixed in `config/demo_config.yaml` before final predictions, plan §17).

**What we say (demo voice-over):**
> "Every artery always gets a prediction: stenosis predicted or not. Separately, Novarion marks a prediction
> 'high support' only where, in internal evaluation on this cohort, that score range met a target we fixed before
> training: right at least 90% of the time when positive, 95% when negative. After the input and stability checks,
> that is about 45% of patients for CAD, right 98.5% of the time in that evaluation, and no patient for the
> individual arteries. Everything else is shown as outside the qualified range, next to how the model did overall.
> This is internal evidence from 303 patients, not clinical validation, and the app says so."

**On screen:** a vessel outside the qualified range (slightly lighter, faint stripes), its line "LAD model ROC-AUC
0.84 in internal evaluation" and its reason. Then a CAD prediction with high support (a clear positive) so the
contrast is visible.

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
- "HIGH SUPPORT · INTERNAL EVALUATION" / "OUTSIDE QUALIFIED RANGE"; never "validated", never bare HIGH/LOW on
  screen, never "certainty". Quote the displayed-scope figures (44.6%, PPV 98.5%), not the threshold-region ones.
- SHAP = "model contribution"; never "risk factor" or "cause".
- The disclaimer is visible in every frame of the video (bold footer line on every screen, the sign-in page
  included) and spoken at the start and end.
