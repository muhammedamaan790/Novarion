# Model evaluation dashboard

Open **Model evaluation** in the workspace navigation, or use `/?view=evaluation`.
The dashboard reads `/api/v1/evaluation`; it does not embed the historical numbers in the README.
Switching back to Case review preserves the current patient, selected vessel, new-case inputs and analysis.
The hidden 3D canvas is unmounted while viewing evaluation and recreated on return.

## What the screen shows

- Selected-model ROC AUC, accuracy, precision, recall and F1 for CAD, LAD, LCX and RCA.
- Target-specific baseline and benchmark comparisons, label prevalence, and counts of defined/undefined folds.
- Brier score, calibration slope and intercept when supplied. The API keys are `cal_slope` and `cal_intercept`.
- High-positive, high-negative and low-confidence coverage, PPV/NPV with supplied 95% bootstrap confidence intervals,
  accuracy within high-confidence regions, and false-negative/false-positive counts in those regions.
- Active model version, explicit evaluation scopes, loading/error/retry/refresh states, and a synthetic-data warning.

Performance cells show **outer-fold mean ± SD**, not confidence intervals. Percentage metric SD is expressed in
percentage points. Undefined metrics remain **NA**; absent optional metrics say **Not supplied**.
The confidence table uses **pooled OOF (prespecified repeat)**. It measures threshold regions before the app's
input-quality and stability gates, so it is not the coverage of the HIGH badge displayed for individual patients.
Internal label prediction does not establish clinical safety, external validity or lesion location.

## Response integrity

The frontend refuses to display incomplete four-target evaluations, invalid numeric summaries/coverage,
mixed selected-model identities, unsupported scopes, or a version different from `/meta`.
It hides cached results while refreshing and after a failed refresh. Queries support cancellation on unmount.
Case-review keyboard shortcuts are inactive in evaluation. Dataset and vessel deep links survive view changes.

## Validation on 11 October 2026

The trained model artifacts remain unavailable. Verification covers the contract mock and deliberately modified
test responses; it does not reproduce historical model performance or verify a real bundle.

- TypeScript, ESLint, production build and generated API type synchronization passed.
- Existing six frontend unit tests passed (Vitest threads pool, native configuration loader).
- Thirteen new evaluation browser scenarios passed: API values/formatting, undefined baselines, optional calibration,
  100% low-confidence coverage, isolated target selection, failure/retry, stale-result clearing, version mismatch,
  incomplete/invalid responses, mixed selected-model identities, controlled non-mock row compatibility,
  case preservation, reload/deep links and mobile table scrolling.
- All seventeen existing case-review, input-race and safety browser scenarios passed after the navigation change,
  including actual vessel picking on the 3D canvas and pinned explanations.

The sandbox prevented the Playwright CLI from launching a worker (`spawn EPERM`). Browser scenarios were executed
from the same tracked test bodies through the connected Playwright browser, in isolated contexts with a small
polling assertion adapter. This is browser-flow evidence, not a successful CLI test-run claim.
Vite's default config bundler also hit a subprocess restriction; `--configLoader native` successfully built and
served the same application. The existing large JavaScript bundle warning remains (~1.34 MB minified).

## Remaining work

Connect a freshly rebuilt, verified model bundle to verify this screen against measured outputs.
Region sample sizes, reliability curves, subgroup results and per-patient failure analysis are not currently
exposed in this view. They must come from saved fold predictions and evaluation artifacts rather than invented
frontend values. Browser Back/Forward routing and persistence across a full reload of an unsaved new case remain
outside the existing URL/store design; view switching itself preserves that case.
