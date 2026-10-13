# Track A compliance audit

Audit of NOVARION against the Track A brief (Cardiovascular Risk Visualization & Prediction). Each item lists the
evidence: the code, a test or a measured result. Status: **Met**, **Met (interpreted)** where the brief is open and
our reading is stated, or **Open** where work remains.

Audited 2026-10-07 and updated 2026-10-13 against production model **v1.0.2**: the same models as the frozen
v1.0.0, plus stability intervals (D-017) and fold-safe evidence ledgers (D-019).

## Prediction

| Brief item | Evidence | Status |
|---|---|---|
| Predict CAD and overall cardiac risk | The CAD classifier is one of four per-target models (`config/targets.yaml`). We define "overall cardiac risk" as the calibrated probability of the dataset's CAD label (`Cath`). The brief supplies no separate risk target, and we never present a 10-year, event or mortality risk. | Met (interpreted) |
| 1a CAD classifier · 1b LAD / LCX / RCA classifiers | There is one nested-CV-selected, calibrated model per target (`scripts/train.py`, `results/metrics.json`). Deployed: LR for CAD, LAD and RCA; shallow XGBoost for LCX. | Met |
| 1c Demographic, exam, ECG, lab and echo inputs | All 55 predictors are covered by `config/feature_registry.yaml`, with types, units, valid ranges and the UNKNOWN policy. Inputs are entered manually or imported from CSV/JSON. | Met |
| 1d Exclude LAD/LCX/RCA/Cath from inputs | A lineage-aware denylist covers {Cath, CAD, LAD, LCX, RCA} and anything derived from them. Tested by `tests/test_leakage.py`; imports strip label columns. | Met |
| Comparison with a traditional clinical score | Table 6: CAD AUC 0.935 vs 0.852 for the updated Diamond–Forrester pretest score (ΔAUC +0.083 [0.042, 0.127]); better calibrated; subgroups by sex and age (Table 7); TRIPOD+AI checklist (`docs/tripod_ai.md`). | Met (beyond the brief) |
| 1e Accuracy, precision, recall, F1, ROC-AUC | Table 1 reports these as outer-fold mean ± SD over 5 × 5 nested CV, beside an always-positive baseline. PR-AUC, Brier and calibration are also reported (`results/tables.md`, Model Evidence page, report §4). | Met |

## 3D visualization

| Brief item | Evidence | Status |
|---|---|---|
| 2a Interactive 3D torso/heart (React Three Fiber) | A BodyParts3D heart with named LAD/LCX/RCA/left-main nodes, plus a translucent torso and rib cage (`frontend/public/models/heart.glb`, `config/anatomy_manifest.json`). | Met |
| 2b Vessel colour driven by predicted probability | OKLCH transfer: the colour family is the predicted class, and the depth is a monotone function of the calibrated probability with t_op as zero. LOW confidence adds hatching. The exact probability is always shown (`frontend/src/three/colors.ts`; `config/anatomy_map.json`). | Met |
| 2c Rotate, zoom, select anatomical regions | Orbit and zoom, five camera presets and a whole-body view. Vessels and the heart can be clicked in 3D or selected from cards (one store action). The torso and ribs are deliberately not pickable, so a click can't land on context instead of a vessel (D-011). | Met |
| Show **where** and **how** | **Where:** the predicted vessel on the heart, tinted as a whole; we never imply a lesion location. **How:** per-vessel feature contributions and group sums. The data has one visit per patient, so we show contributing factors, not progression. | Met (interpreted) |
| Output ↔ vessel correspondence | `config/anatomy_map.json` binds each target to its node, camera and label anchor (`tests/test_anatomy.py`). | Met |
| Real-time visualization updates | Editing a measurement triggers a debounced (300 ms) `/predict`; vessels recolour with easing and stale responses are discarded. `/predict` p95 is 104 ms on the Docker stack, against a 200 ms budget (`results/perf.json`). | Met |
| No dedicated GPU required | 3D runs at a median 59.9 fps (p5 58.8) on Intel Iris Xe integrated graphics (`frontend/scripts/bench_fps.mjs`). A 2D SVG fallback covers missing WebGL, and the scene recovers from context loss. | Met |

## Explanations and dashboard

| Brief item | Evidence | Status |
|---|---|---|
| 3a CAD status and vessel probabilities beside the canvas | On a case's Result tab: a two-line summary, then one line per target (binary call, probability, model confidence) beside the 3D view; a line expands to its stability interval and confidence reasons (D-022). | Met |
| 3b SHAP/LIME explanation | Exact additive SHAP in calibrated log-odds: linear SHAP, TreeSHAP or EBM terms. The sum rule is tested for every served explanation (`tests/test_ml_core.py`, `tests/test_bundle.py`). | Met |
| 3c Measurements and their relative contribution | The Why panel's measurement table shows each value, its contribution, a relative-share column and cohort percentiles; a compare-all-vessels heatmap sits alongside. | Met |
| What-if and robustness (plan Tier 3) | `POST /sensitivity` ICE curves for new/edited cases (age and sex locked; "model sensitivity, not treatment simulation"), Unknown inputs that could flip the class, model-family agreement (Table 3b), a 1,000-shuffle label-permutation test (Table 1b, p = 0.001 for every target) and stability bars on the cards. | Met |
| Explanation dashboard | The Model Evidence page carries Tables 1–2, ROC/PR curves with bootstrap bands, reliability, threshold sweep and family benchmarks. | Met |

## Assets, safety and technology

| Brief item | Evidence | Status |
|---|---|---|
| 4 Open-source meshes | BodyParts3D 4.0 (CC BY 4.0), attributed in `CREDITS.md` and in the UI footer. | Met |
| 5 Clinical-safety disclaimer | A persistent one-line footer on every screen, the sign-in page included ("Decision support / educational purposes only. Not a substitute for formal diagnostic imaging."), also on Review Snapshot PDFs. E2E checks it is visible (D-022). | Met |
| Extensibility | Features, targets and anatomy are driven by registries. An adjacent example is the learning loop, which adds models without code changes (D-018). | Met |

## Deliverables

| Deliverable | Evidence | Status |
|---|---|---|
| Web app | Docker stack (`docker compose up` → http://localhost:8080, READY in ~15 s; `NOVARION_API_PORT` / `NOVARION_WEB_PORT` move it off busy ports) and a dev setup. Offline demo mode serves a hash-verified static bundle. | Met (local); **Open:** a public hosted URL, if the submission requires one |
| Trained pipeline + weights | `make reproduce` reruns everything. Bundle `artifacts/models/v1.0.2` has per-file hashes, and the backend refuses a modified bundle. Weights are gitignored and rebuilt by `make reproduce`. | Met; **Open:** decide whether to attach the bundle to a GitHub release |
| ≤ 6-page documentation | `docs/report.pdf`, 4 pages, with every number read from `results/` at build time. Also `docs/model_card.md` and `docs/decisions.md`. | Met |
| 3–10 min YouTube demo | Recorded at the end of the project, by the team. | **Open** |

## Verification status (plan §15 order)

| Gate | Result |
|---|---|
| Python tests | 198 pass: leakage, contract, additivity, calibration, thresholds, hashing, bundle integrity, golden set, stability, learning loop, input edge cases, sensitivity, concurrency, budgets, secret scan, guideline comparator, sign-in (D-022). |
| Frontend unit tests | 24 pass (vitest), plus typecheck, lint and generated-API sync. |
| Browser E2E | 57 flows pass on the rebuilt Docker stack with the real model and against the mock, after the D-022 redesign (2026-10-13, Edge). The earlier 50-flow run covered **Edge, Chrome and Firefox** (`results/browser_matrix_log.txt`). They include axe accessibility checks (also on the no-WebGL fallback), failure injection, offline mode, WebGL fallback and context loss, storage damage and deletion, what-if, the learning loop, a same-origin privacy check, the PR #1 regression suites, and the sign-in page, sign-out and expired sessions. |
| GitHub CI | **Met.** Python, frontend and e2e jobs green on `main` (fresh Linux runners, CI-safe single worker). |
| Fresh-clone reproduction | **Met.** A full `make reproduce` on a fresh clone with freshly downloaded data matched every fold, metric, golden prediction, stability interval and replay result exactly (`results/reproduction.json`, D-020). |
| Performance and memory | **Met.** `/predict` p95 104 ms (Docker, budget 200 ms); 3D median 59.9 fps on integrated graphics; backend RSS 178 → 184 MB peak; offline bundle 3.5 MB gzipped (budget 25 MB); JS heap 13 MB after 30 patients (`results/perf.json`). |
| Second-machine test · rehearsals · outside-user usability test | **Open** (team). `scripts/compare_reproduction.py --other PATH` checks a second machine's run. |

## Claims we deliberately do not make

- No diagnosis, lesion localization, or test or treatment recommendation.
- No external validation: everything is internal nested CV on one public, 303-patient, high-prevalence cohort.
- The vessel models never reach HIGH confidence, because no region met the pre-registered PPV/NPV targets. They still give a binary call.
- The replay study is a "historical replay · NOT temporal validation". It shows a flat learning curve for CAD, LAD and RCA and a rising one for LCX, and the gate passed in only 1 of 20 replays.
- The learning loop is "designed for continual supervised updating". It never learns from its own predictions and never promotes a model without a person.
