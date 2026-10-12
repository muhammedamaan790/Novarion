# Novarion deep audit: fixes, evidence and next contributions

Reviewed 11 October 2026 against original main `f0d531b3fd11e1c608c515d5080c3d3474effdef` and contributor branch
`nikil/progress-audit`. The supplied Track A PDF defines the submission requirements; the supplied master plan is
background scope, not evidence of implementation. The existing design and four-target approach are retained.

## Outcome

The project has a substantial working foundation, but the original build contained reproducible API, browser and
scientific-evidence defects. This branch corrects those defects and adds regression coverage. It does **not**
establish improved accuracy or a clinically validated risk score. The trained weights and saved fold outputs are
missing from GitHub; the user confirmed they are currently unavailable. Real inference and numerical reproduction
remain pending. Mock mode remains visibly marked **MOCK DATA · NOT A MODEL**.

The best contribution now is a reliable, artifact-backed demo plus an evaluation screen. Rebuilding the whole UI,
adding a generic chatbot, or implementing the entire master plan would dilute the submission.

## Corrections made

| Area | Problem and evidence | Result after the fix |
|---|---|---|
| Clinical-number validation | Small requests containing age `1e30`, `1e308`, or a 401-digit integer produced HTTP 500. Supplied computed BMI values could also raise conversion/Decimal errors. Nine new tests failed before correction | Impossible magnitudes are rejected before rounding; computed values remain server-authoritative; original canonical hashes and train/serve parity tests still pass |
| Strict JSON parsing | Python's decoder can overflow scientific notation or raise recursion/integer-limit errors before shape validation | Non-finite decoded values, deep JSON and decoder errors consistently produce validation envelopes; long Content-Length values cannot overflow integer conversion |
| Model confidence | A qualified region with zero held-out examples raised instead of returning a valid four-target prediction | Retain the probability/class, downgrade to LOW, and explain that validation evidence is absent; never invent a PPV/NPV |
| Calibration | Optimizer failure was accepted; separated scores yielded a finite calibration slope despite an undefined free-slope maximum-likelihood estimate | Require successful finite fits; detect complete/quasi separation and constant margins; report undefined slope as NA |
| Training reproducibility | Changing ML code could reuse old fits, and evaluation could stamp stale fold results with the current key | Fingerprint implementation and locked runtime; check fold keys, IDs, labels and result lengths before evaluation/packaging |
| OOF evidence leakage | Reference patients' global OOF score fits could contain the query patient's label, indirectly influencing evidence-band membership | Future fold ledgers use only inner cross-fitted scores from that outer-training partition. Unsafe legacy ledgers are withheld at serving with a visible notice; valid held-out predictions/explanations remain available |
| Bundle startup | Live feature/target configuration and production registry identity were not fully checked against the trained bundle | Reject incompatible feature/target definitions or registry identity before loading models. Permit only LF/CRLF conversion for text-config compatibility |
| Bundle rebuilding | Replacement needed safeguards before removing an existing output | Validate cache/evidence inputs first; restrict replacement to resolved artifact or dedicated scratch directories. Corrected exports target v0.1.1, preserving v0.1.0 |
| Dataset prefill race | A delayed first selection overwrote a later patient's form: expected weight 67, received 54 | Abort old prefills and commit only the current request; manual edits cancel pending prefills too |
| Prefill failure and stale status | Failed selection retained old results while claiming the prediction was current | Clear predictions/validation immediately, show loading/error state, and handle failures without an unhandled promise |
| Keyboard controls | Number/Escape keys inside a select changed the inspected vessel | Editable controls and modified shortcuts no longer trigger global target selection |
| API/four-target commit | HTML returned with HTTP 200 looked successful; new-case code lacked an explicit all-target commit guard | Invalid JSON/object responses become errors; a partial prediction never commits vessel colours or cards |
| 3D loading failure | A missing heart file crashed the app | A scoped error boundary/WebGL fallback retains patient, target and prediction panels with an explicit unavailable-view message |
| Narrow screens | A 390-pixel viewport overflowed to 457 pixels; the fixed-height composition constrained the form | Header wraps; small-screen layout scrolls vertically and preserves a usable form; desktop layout remains recognisable |
| Confidence wording | LOW could be caused by atypical/unknown inputs even inside a qualified threshold region. Table 2 omitted those extra app gates | Correct HIGH/LOW copy; label threshold-only cohort statistics; surface analysis provenance notices |

The six original UI failure scenarios were reproduced before their fixes and passed afterward. Two further tests
cover incomplete predictions and manual edits during prefill. Scientific regressions reproduce conditional defects
without pretending to use trained weights. See [scientific-research.md](scientific-research.md) for primary sources,
scientific reasoning, exact code pointers and remaining methodological limits.

Visual review also separated the mobile colour legend from the anatomy attribution so they no longer overlap.

## Verification receipt

| Check | Result / scope |
|---|---|
| Python tests | 144 passed; 1 module-level skip excludes the trained-bundle suite; dependency deprecation warning |
| Python lint | Passed |
| Frontend unit tests | 6 colour tests passed |
| TypeScript / lint / generated API sync / production build | Passed |
| Browser tests | 17 passed in Edge against the labelled mock backend |
| Visual review | Desktop 1440×900 and mobile 390×844 inspected; screens show synthetic mock outputs |
| Data verification | Pinned UCI archive checksum; 303 rows × 59 columns; 55 predictors; all four label columns excluded |
| Actual trained-model inference / 303 real OOF bundles | Pending: artifacts unavailable; not replaced with dummy weights |
| Docker / deployment / clinical validation | Not verified in this audit |

The approximately 1.32 MB minified frontend chunk still produces a build warning. This is a performance task, not a
failed build. An automatic approval review rejected downloading/running the external 21st review CLI because of
third-party execution/source-exposure risk; the UI conclusions here use local code and browser tests instead.

## What the existing metrics can support

The checked-in tables report outer-fold mean ROC-AUC of CAD 0.930, LAD 0.838, LCX 0.721 and RCA 0.736. These are
historical repository claims, not measurements reproduced by this audit. The vessel models are materially weaker
than overall CAD. All three vessel targets have 100% LOW confidence in the reported prespecified threshold table;
do not lower thresholds after inspecting those outcomes to make a demo look stronger.

The labels describe current CAD/≥50% vessel stenosis. They do not supply a follow-up horizon for heart attack,
mortality or ten-year cardiovascular risk. Probability is not percentage narrowing. The heart is reference anatomy,
not a patient's reconstruction or a localized plaque map. [UCI dataset description](https://archive.ics.uci.edu/dataset/411/extention+of+z+alizadeh+sani+dataset)

After regeneration, calculate a second coverage/PPV/NPV table using the **exact app quality policy**. The original
Table 2 evaluates threshold regions before unknown/atypical downgrades. Those cohorts differ, so its rates must not
be described as measured performance of the displayed HIGH badge. This branch labels the distinction but cannot
calculate corrected numbers without the real folds. Explanations describe model attribution; what-if edits do not
establish treatment effects. [SHAP authors' explanation](https://shap.readthedocs.io/en/latest/example_notebooks/overviews/Be%20careful%20when%20interpreting%20predictive%20models%20in%20search%20of%20causal%20insights.html)

One existing data decision is intentionally retained: source record 153 (zero-based, ZAS-0154) marks obesity as
positive at BMI 25.0, while the manual-case rule computes obesity as BMI >25. This documented one-row mismatch
means prefilling that source record can change its canonical hash and switch to final-model analysis. The original
dataset labels/features are preserved; the warning must not be mistaken for failed OOF prediction verification.

## Prioritised work already in the plan

Estimates below are planning estimates for focused implementation after dependencies are available, not promises.

| Priority | Work | Suggested owner / estimate | Definition of done |
|---|---|---|---|
| P0 | Corrected, reproducible model release | Friend + joint review; old README estimates training around 1.5 hours on 10 CPU cores, actual duration unverified here | Fresh locked training, v0.1.1 bundle, complete fold outputs, manifest and real readiness; all 303 patient files validate |
| P0 | Real end-to-end demo and handoff | Together; 1–2 hours after artifacts | Four real targets, matching vessel selection/colours, additive explanations, explicit imputation/confidence and another-machine run |
| P1 | Evaluation/evidence screen | You; 3–5 hours | All four targets, official metrics, baselines, sample counts, calibration and honest scope/limitations from the API |
| P1 | Compact case save/reopen + review snapshot | You; 5–8 hours | Inputs/results/model version survive reload; changed inputs invalidate old results; exported snapshot includes disclaimer and provenance |
| P1 | Deployment and submission package | Together; depends on platform | Verified application URL, report ≤6 pages and working 3–10 minute demo-video link; judges can reproduce the core loop |
| P2 | Performance and device robustness | You; 2–4 hours | Measure cold-load and frame rate; split/defer the heavy 3D code if measurements justify it; test failed loads and target touch controls |

Learning-loop governance, model promotion and a large Model Center remain optional scope. Avoid making them a
dependency of the required hackathon demonstration.

## New features absent from the supplied plan

The plan already contains scenario sensitivity, stability, attribution charts, cohort comparisons, saved cases,
review snapshots and model evidence. Those are unfinished planned features, not new discoveries.

| Recommendation | Value beyond the plan | Estimate / acceptance check |
|---|---|---|
| **1. OOF failure explorer** | A target-specific TP/TN/FP/FN grid links every category to its full patient list and opens an incorrect case in 3D | 3–5 hours after artifacts. Counts reconcile exactly with fixed OOF labels/predictions; no cherry-picked successes; never mix final-model results into validation |
| **2. Subgroup performance explorer** | Show age-band/sex-specific errors, calibration and confidence coverage, rather than only feature comparisons | 4–6 hours after artifacts. Fixed exploratory bins, visible denominators/class balance, unsupported cells suppressed; no fairness claim from this small cohort |
| **3. Human-first educational review** | Learner records a provisional assessment before revealing AI results, then sees the fixed OOF explanation and eventual label | 3–4 hours after case-state foundations. AI scores/colours remain hidden until reveal; assessment is saved first; no claim of improved clinician performance |
| **Later: decision-utility research tab** | Compare net benefit against default strategies under explicitly hypothetical decision preferences | 4–6 hours plus methodological review. Define the action/preference assumptions; no clinical testing/treatment recommendation; use fixed OOF outputs |

Implement the failure explorer first if time remains after real integration and the evaluation screen. It exposes
what the system gets wrong and makes the weaker vessel models understandable to judges. For supporting research
and the feature-to-plan comparison, see [scientific-research.md](scientific-research.md#5-new-features-genuinely-absent-from-the-supplied-plan).

## Handoff and first hour

1. Review this branch with your friend and agree the corrected model-release owner. The main branch remains unchanged.
2. The friend should rerun the locked pipeline using this branch; legacy fits cannot be restamped as corrected results.
   `scripts/train.py all` recomputes changed-cache fits; `scripts/build_bundle.py` exports v0.1.1 only after provenance checks.
3. Share the complete model directory, `results/nested/`, `results/final/` and regenerated metrics/split manifest.
   Missing artifacts remain an explicit gap, not a successful verification.
4. Once available, start a separate real backend, run the trained-bundle tests and the browser suite with
   `E2E_BACKEND=real`; do not point that run at a mock server.
5. While waiting, build the planned evaluation screen against contract fixtures with the persistent mock badge.

For the prepared checkout's Windows startup commands, see [initial audit](progress-audit.md#windows-startup-for-the-prepared-local-checkout).
The model-release and data steps use Python 3.11 with the committed lockfile. The anatomy asset is already committed.

## Sources and review boundaries

- User-supplied Track A PDF: official requirements, deliverables and judging weights.
- User-supplied master plan: accepted direction and planned features; document instructions treated as background.
- Original repository and all source/configuration/contract files involved above.
- Checksum-verified UCI workbook; existing tables labelled as historical, unreplicated results.
- Primary papers and official SciPy, scikit-learn, SHAP and reporting guidance linked in [scientific research](scientific-research.md).
- Local regression failures, successful checks and browser inspection; no clinical validation or new accuracy claim.
