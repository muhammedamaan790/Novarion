# Novarion — Decision log

Each entry records a methodology decision required by the master plan, with evidence and date.
Entries are append-only; a changed decision gets a new entry that supersedes the old one.

---

## D-001 — Discordant label record (row 93)

- **Date:** 2026-10-04
- **Status:** DECIDED
- **Trigger:** Plan §16 stop rule — "CAD / Cath / vessel labels don't match their documented definitions → stop training until resolved and documented."
- **Evidence:** `data/schema_report.json` (source SHA-256 `739343245c2ba578b541370217531750d8e936022f928b83e0d91756caa3ff0b`).
  The overall CAD label `Cath` agrees with "any of LAD/LCX/RCA = Stenotic" for 302 of 303 records.
  Row 93 (0-based index in sheet `Sheet 1 - Table 1`): LAD = Stenotic, LCX = Normal, RCA = Normal, Cath = Normal.
- **Decision:** **Keep the record and all labels exactly as provided.** Each of the four models (CAD from `Cath`, LAD, LCX, RCA) is trained on its own label as published. No record is excluded and no label is modified.
- **Rationale:** The four targets are modelled independently (plan §6.6), so the record is valid input for each target as labelled. Altering or dropping published labels without source evidence would be unjustified data manipulation.
- **Consequences:**
  - The labels are *not strictly nested*, so the optional UI note for conflicting predicted classes (plan §6.6, conditional on nested labels) is **not** shown.
  - The report states the 302/303 agreement and this discordant record explicitly.
  - The training stop rule is cleared.

---

## D-002 — Computed BMI and Obesity for new cases

- **Date:** 2026-10-04
- **Status:** DECIDED
- **Evidence:** `BMI` equals `Weight / (Length/100)^2` exactly in all 303 source rows. `Obesity` equals `BMI > 25`
  (the published definition, arXiv:2001.09841 feature table) in 302/303 rows; row 153 has BMI = 25.0 and is marked "Y".
- **Decision:** For **new/manual cases**, `bmi` and `obesity` are **computed** (never typed) from weight and height,
  using the documented formula and rule (`input_mode: computed` in `config/feature_registry.yaml`), so inputs can
  never be internally inconsistent. **Training data keeps the source values unchanged** (consistent with D-001).
  The `redundancy_reduced` feature-set option drops `weight`, `height` and `obesity` (BMI carries the information).
- **Consequences:** the manual form does not ask for BMI or Obesity; imports that include them are recomputed and a
  mismatch is shown as a quality-gate warning. The boundary case (BMI exactly 25.0) is a documented 1-row train/serve
  difference.

---

## D-003 — Registry facts verified against the source file

- **Date:** 2026-10-04
- **Status:** DECIDED
- **Facts recorded in `config/feature_registry.yaml`:** no "Rhythm" column exists (the published table lists one; the
  file is authoritative); Function Class is 0–3 (the table lists 1–4); Sex is encoded "Male"/"Fmale" in the source;
  `Exertional CP` is constant ("N") and is removed by the fold-local zero-variance step; Region RWMA meaning is not
  documented, so it is nominal by default. Units come from the published feature table; age/weight/height units are
  implied (not printed) and weight/height are therefore `unit_unambiguous: false` for imports.

---

## D-004 — 3D anatomy asset source

- **Date:** 2026-10-04
- **Status:** DECIDED
- **Decision:** Use **BodyParts3D 4.0** (IS-A tree OBJ set; CC BY 4.0 per the official licence page) as the primary
  mesh source. The procedural-vessel fallback (plan §9.1-3) is **not needed**.
- **Evidence:** `scripts/build_anatomy.py` resolves FMA concepts to element meshes. LAD (FMA74912 + FMA13921, 21
  files), LCX (FMA3895, 6), RCA (FMA3802 + FMA66327, 31), left main (FMA3855, 1) and heart wall (FMA13256, 3) map to
  **disjoint** element sets. Decimated output: 81,992 triangles (budget 150k), GLB 1.55 MB. A visual QA preview
  (`results/anatomy_qa_preview.png`, anterior + left-lateral) shows LAD down the anterior interventricular groove,
  LCX around the left AV groove, RCA around the right AV groove to the inferior border, and the left main at the origin.
- **Consequences:** `config/anatomy_map.json` maps TargetId → node (cad → heart_myocardium; lad/lcx/rca →
  vessel_*; vessel_lm is non-target and informational only). Attribution is in `CREDITS.md` and the manifest.
  `torso_shell` is deferred to the 3D engine milestone (plan §9.1 lists it; it is non-target and does not affect
  TargetId correspondence). Draco compression is deferred to the frontend build (the GLB is already 1.55 MB).
  In-app pointer picking and per-preset camera framing still have to be verified in R3F (M3).

---

## D-005 — Public patient identifiers

- **Date:** 2026-10-04
- **Status:** DECIDED
- **Decision:** `patient_id = "ZAS-" + zero-padded 4-digit (dataset_record_id + 1)`, i.e. source row 0 → `ZAS-0001`,
  row 302 → `ZAS-0303`. Implemented once in `novarion_ml.data.load.patient_id` / `dataset_record_id`; the API pattern
  is `^ZAS-\d{4}$`.
- **Why:** the plan used both `ZAS-023` and `ZAS-0033`; one fixed width avoids two spellings of the same patient in
  deep links, snapshots and the offline bundle.

---

## D-006 — Contract v0 freeze and mock conventions

- **Date:** 2026-10-04
- **Status:** DECIDED
- **Decision:** `backend/app/schemas.py` is the contract; `contracts/openapi.json` and every `contracts/mock_*.json`
  are generated by `scripts/build_contracts.py` (deterministic; a test regenerates them and fails on any byte diff).
  Mocks come from `MockService`, a deterministic toy engine that is **not a model**: `model_version = 0.0.0`, bundle
  hashes of the string `novarion-mock-bundle`, response header `X-Novarion-Mock: 1`. Its feature centres are real
  cohort statistics (`mock_reference.json`); weights, thresholds, cohort comparisons and evidence are synthetic.
  Without a verified bundle (`NOVARION_MOCK` unset) the API fails closed: `/health/ready` 503, model endpoints
  `NOT_READY`.
- **Scope deliberately left out of v0:** `/predict/batch`, `/sensitivity` (Tier 3) and `/models/{v}/promote`
  (lifecycle CLI first; the route will exist only in local mode). Rate limiting is a Day 15–17 hardening item.
- **Golden hashes:** `tests/golden/input_sha256_vectors.json` (50 vectors: 40 dataset rows + edge cases) is frozen by
  `scripts/build_golden_hashes.py`; any change to them is a MAJOR preprocessing-version bump. A parity test proves
  that all 303 rows hash identically through the API canonicalizer and the training loader, except the documented
  D-002 row 153 (obesity).

---

## D-007 — Two contract gaps closed: constant feature, case origin

- **Date:** 2026-10-04
- **Status:** DECIDED
- **Constant feature:** `exertional_chest_pain` is "N" in all 303 records (D-003) and is removed by the fold-local
  zero-variance step, so it can never affect a prediction. It is now `input_mode: constant` (`constant_value: 0`):
  never asked in the form, never required in requests, always filled by the canonicalizer. A supplied non-zero value
  is reported as a WARN (`constant_feature_ignored`) and ignored. The canonical vector and every `input_sha256` are
  unchanged (the 50 golden vectors still pass). Any future zero-variance feature follows the same rule.
- **Case origin:** `patient.source` (dataset / manual / import) was removed from server responses. The stateless
  server cannot know where a case came from (the request carries no such field), so the **frontend CaseStore owns
  `case.source`**. The server reports only `patient.prediction_mode` (`oof` | `final_model`), which it does know.

---

## D-008 — Pre-registered presentation rules for confidence tiers and performance (before any results)

- **Date:** 2026-10-04 (written before any real model output exists)
- **Status:** DECIDED
- **Rule 1 — thresholds are never moved for the demo.** If most predictions land in LOW MODEL CONFIDENCE, the
  pre-registered targets (PPV 0.90, NPV 0.95, n_min 15 in `config/targets.yaml`) stay as they are. Lowering them
  after seeing outer-fold results would be test-set tuning. The share of LOW predictions per target is reported in
  Table 2 as a finding.
- **Rule 2 — demo wording is fixed now** (see `docs/presentation_notes.md`): LOW is presented as the system working
  as designed (it refuses to overstate), and the binary prediction is still shown for every vessel.
- **Rule 3 — performance is framed against honest baselines**, never against published accuracies from unknown or
  leaky validation designs (prepared answer in `docs/presentation_notes.md`).

---

## D-009 — Training pipeline implementation choices (plan §5.2, §6, §8)

- **Date:** 2026-10-04
- **Status:** DECIDED
- **Feature sets in the v1 grid:** exactly the plan's `{full, redundancy_reduced}` (92 configurations). Engineered
  features (NLR, LDL/HDL, TG/HDL, risk-factor count) are **not** in the v1 grid; they are evaluated in the Day-9
  ablation only, so the frozen grid and its `train_config_sha256` stay as pre-registered.
- **Cross-fitting for Platt:** the selected configuration's cross-fitted margins come from the same inner folds used
  for selection (inner refits of the selected config, plan §6.4), so no extra cross-fit runs are needed.
- **Splits are stratified per target**, so a patient's outer fold differs by target. The contract field is therefore
  `outer_folds: {cad, lad, lcx, rca}` (was a single `outer_fold`).
- **Explainers (all exactly additive in the raw margin, golden-tested):** LR = interventional linear SHAP with the
  model's own training partition as background (its exact mean, not a k-means summary); XGBoost / CatBoost = native
  TreeSHAP (path-dependent, includes the bias term; no background needed); EBM (interactions = 0) = native term scores.
  The plan's k-means background (§11A) is therefore not needed in v1. Calibrated contributions = a × raw, base =
  a·base + b.
- **Atypical profile in OOF mode:** each target has its own outer-training reference; the analysis-level flag is the
  OR over the four targets' references, so any atypical finding forces LOW for all targets (conservative).
- **Similar patients / ledger in OOF mode:** built from the patient's outer-training rows for that target; the ledger
  uses those patients' evaluation-repeat OOF probabilities (never the patient's own label).
- **HIGH region without outer evidence:** if a deployed HIGH region had zero outer-validation patients, the engine
  raises instead of quoting an unmeasured PPV/NPV.
- **Bundle version:** `0.1.0` is the development bundle (pre-freeze). `1.0.0` is reserved for the Day-10 model freeze.

---

## D-010 — Demo-bundle hash DAG (closes a cycle in plan §10)

- **Date:** 2026-10-04
- **Status:** DECIDED
- **Problem:** plan §10 lists `demo_bundle_sha256` inside `manifest.json`, while every patient file in the demo
  bundle carries `artifact_manifest_sha256` — a hash cycle.
- **Decision:** `manifest.json` covers the model artifacts only (models, calibrators, thresholds, reference contexts,
  schemas, evaluation, split manifest; per-file SHA-256). `demo_bundle/index.json` is
  `{"index": {artifact_manifest_sha256, patients, files: {path: sha256}}, "demo_bundle_sha256": SHA-256(JCS(index))}`.
  The backend verifies both at startup and fails closed on any mismatch (tested by tampering with a copy).

---

## D-011 — Body context: translucent torso + rib cage (supersedes the D-004 deferral of `torso_shell`)

- **Date:** 2026-10-04
- **Status:** DECIDED
- **Decision:** add two **context** nodes from the same BodyParts3D 4.0 source (CC BY 4.0): `torso_shell` (skin,
  FMA7163, cropped to the trunk: z 880–1480 mm, |x| ≤ 185 mm, keeping whole triangles only) and `rib_cage` (ribs,
  costal cartilages, thoracic vertebrae, manubrium, sternal body, xiphoid). Budgets 20k + 30k; total 132k ≤ 150k.
- **Why:** the brief asks for a "torso/heart model" and an understanding of *where* pathology sits in the body; the
  heart alone did not show its position in the chest.
- **Rules:** context nodes are never prediction targets, never pickable (raycast disabled, so they can never
  intercept a vessel click — covered by the canvas-picking E2E test), never coloured by predictions, and never
  occlude label anchors. Their opacity fades with camera distance (full context when zoomed out, ~12 % in vessel
  close-ups) so they never wash out the vessel colours. A "Body context" toggle hides them; a "Whole body" camera
  preset shows them. The heart-based normalization is unchanged, so vessel coordinates, anchors and presets are
  identical to before.

---

## D-012 — Case workflow v1 (plan §12A): what is implemented, what is deferred

- **Date:** 2026-10-04
- **Status:** DECIDED
- **Implemented:** IndexedDB CaseStore (Dexie, `case_schema_version` 1.0.0); dataset cases store the OOF bundle with a
  case-specific `analysis_id` (the canonical `source_oof_analysis_id` is kept); new/imported cases persist through one
  `/analyze/full` call and one IndexedDB transaction (all-or-nothing); edits after saving become a new **edited
  scenario** (never an overwrite); immutable review revisions bound to `analysis_id` (status derived, "Review recorded",
  no accept/diagnose button); Review Snapshot = `{snapshot, snapshot_sha256}` built only from the stored analysis +
  stored review, RFC 8785 JCS in TypeScript (verified against 60 reference vectors from the Python `rfc8785`
  implementation), 3D image rendered off-screen from the camera preset at final material state and embedded with its
  `image_sha256`; PDF and JSON rendered from the same stored object; case history with JSON export; stored cases
  reopen with the backend unreachable (E2E-tested with all API calls blocked).
- **Deliberate deviations:** the PDF embeds a JPEG display copy of the image (the hashed record keeps the exact PNG);
  vessel labels are not drawn into the snapshot image (they are listed in the predictions table instead).
- **Deferred (tracked):** ~~draft recovery~~ (done 2026-10-07: IndexedDB `drafts` table via an additive Dexie v2
  schema; offered on the next visit, never applied silently, cleared when saved), a "Re-analyze with the current model" button
  (the outdated-model banner exists), case JSON import, outcome recording + learning loop (Tier 2, last in the cut
  order), automatic local backups before migrations (no migration exists yet: schema 1.0.0).

---

## D-013 — Model freeze v1.0.0, golden set, demo patients, ablation and error-analysis scope

- **Date:** 2026-10-04
- **Status:** DECIDED
- **Model freeze:** the trained models are packaged as bundle **v1.0.0** (`scripts/build_bundle.py`, default
  version). No feature-schema, grid, training, calibration or threshold change after this point; a release-blocking
  fix becomes a new artifact version with every affected validation rerun (plan §11A "Freeze types"). The registry
  keeps the history (v0.1.0 → `retired`, never deleted).
- **Golden prediction set:** `golden/golden_predictions.json` inside the bundle (21 dataset records + 3 edge cases:
  UNKNOWN input, out-of-cohort triglycerides, female with typical chest pain) records classes, confidence regions and
  reasons (exact), probabilities and calibrated logits (|Δ| ≤ 1e-6) and every contribution (rtol 1e-6, atol 1e-5).
  `tests/test_golden.py` requires the production bundle to reproduce them; a release that cannot is not a patch.
- **Demo patients:** `config/demo_config.yaml` picks the main demo patient and Case B by an **outcome-blind hash
  rule** (`int(sha256(seed), 16) mod 303`). Some patients' predictions were seen during development, so no person
  chooses; the rule is recomputable (`tests/test_demo_config.py`). Case B's correctness is revealed live.
- **Ablation (descriptive):** each feature group removed and the training-side procedure re-run on the same 25 outer
  folds, **restricted to the logistic-regression family** of the grid (LR was selected in 79/100 outer folds). The
  full four-family re-run per variant (~9 h) is not justified for a descriptive analysis; the scope is printed in
  every output.
- **Error analysis:** representative cases chosen by stated rules (lowest patient id meeting each criterion). The
  rule for "error in the CAD high-positive region" selects ZAS-0094, which is exactly the D-001 label-discordant
  record; this is reported, not hidden.

---

## D-014 — Docker verified; slimmer inference dependencies

- **Date:** 2026-10-07
- **Status:** DECIDED
- **Verification:** `docker compose up` (backend + nginx frontend, weights host-mounted read-only) → backend healthy and
  READY with model v1.0.0 in **14 s** from cold start; **all 16 Playwright E2E flows pass against the Docker stack**
  (`E2E_BACKEND=real E2E_BASE_URL=http://127.0.0.1:8080 npx playwright test`). The check found and fixed one real
  defect: the frontend image did not contain `contracts/`, which the production type-check needs.
- **Dependencies:** `shap` was never imported (explainers are native, D-009) → removed. `interpret` → `interpret-core`
  (same `interpret.glassbox` EBM classes, no dashboard stack). `xgboost` → `xgboost-cpu` (official CPU-only wheel,
  same module and model format, without ~470 MB of NCCL/CUDA libraries; the system must run without a dedicated GPU).
  All 28 saved models in the v1.0.0 bundle load unchanged and the golden prediction set still reproduces.
  Backend image: **3.03 GB → 1.28 GB**; frontend image 81 MB. CatBoost is kept although no v1.0.0 model uses it, so a
  future bundle that selects it still loads.

---

## D-015 — Hardening pass 1 (plan Days 15–17)

- **Date:** 2026-10-07
- **Status:** DECIDED
- **Rate limiting:** per-client token bucket (600/min, burst 200; env-configurable) on every API route except health
  checks; 429 uses the standard error envelope + `Retry-After`. Behind our nginx the client address comes from
  `X-Real-IP`, trusted only when `NOVARION_TRUST_PROXY=1` (set in docker-compose), so the header cannot be spoofed on a
  directly exposed backend (tested).
- **Latency (Docker, this laptop, `results/perf.json`):** `/predict` p50 46 ms / **p95 67 ms** (budget 200 ms);
  `/validate` p95 19 ms; `/explain` p95 76 ms; `/analyze/full` p95 112 ms; patient bundle p95 51 ms.
- **WebGL:** no WebGL → the emergency 2D schematic (same store, same colours, clickable); context lost mid-session →
  an explanatory overlay with "Restore 3D" while all panels keep working.
- **Failure injection (E2E):** backend unreachable → visible message, no predictions; a failing prediction fails
  closed (no stale cards or colours, neutral anatomy); rapid edits are debounced and only the final value is sent.
- **Accessibility:** axe-core reports no serious/critical violations on the Command Center or Model Evidence pages
  (fixed: an ARIA attribute without a role on the 3D container, low-contrast keyboard hints and secondary text).

---

## D-016 — Offline demo mode (plan §10 run modes)

- **Date:** 2026-10-07
- **Status:** DECIDED
- **Implemented:** `scripts/export_demo_bundle.py` (also run by `make bundle`) copies the production bundle's
  per-patient OOF files plus static `/meta` and `/evaluation` snapshots to `frontend/public/demo_bundle/` (gitignored,
  29.8 MB raw; ~14 KB per patient over gzip). At startup the frontend uses the live API if `/health/ready` answers
  within 4 s; otherwise it loads the static bundle **only if** its `demo_bundle_sha256` (RFC 8785 JCS) verifies and its
  schema/compatibility range matches, and shows "DEMO MODE · STATIC BUNDLE". A tampered bundle is refused (tested).
  Offline: all dataset-patient flows, label reveal, Model Evidence, saving/reviewing cases and Review Snapshots work;
  new cases, live editing and validation are disabled with an explanation (no claim of live inference). If the backend
  dies mid-session, the error offers "Switch to offline demo" (tested).
- **Found and fixed:** re-selecting the already-open dataset patient cleared its analysis without reloading it.
- **Not cut, not done:** the OOF stability bootstrap (plan §6.10a, Tier 2) remains unimplemented; adding intervals now
  would change the frozen bundle's patient files, and every vessel is already LOW confidence, so it is the first
  candidate to cut under the plan's cut order.
- **Addendum (2026-10-07) — 3D frame rate:** `frontend/scripts/bench_fps.mjs` (30 s scripted orbit drags, vessel
  selections, compare mode and the whole-body preset, 1600×900, 131,990 triangles) on this laptop's **Intel Iris Xe
  integrated GPU** (ANGLE/D3D11, renderer string recorded): **median 59.9 fps, p5 58.8 fps** — the plan's 60 fps
  design goal on integrated graphics (acceptance ≥ 45 fps). Stored in `results/perf.json`.
- **Addendum (2026-10-07) — browser compatibility:** the full Playwright suite (28 flows: dataset review, 3D picking,
  compare, import, new case, cases/snapshots, draft recovery, offline mode, failure injection, WebGL fallback and
  context loss, accessibility) passes in **Edge, Chrome and Firefox** (`PW_CHANNEL=chrome`, `PW_BROWSER=firefox`).

## D-017 — Stability intervals (plan §6.10a) → bundle v1.0.1 (patch)

- **Date:** 2026-10-07
- **Status:** DECIDED (supersedes the D-016 note that the stability bootstrap was not done)
- **Method (algorithm B, as pre-registered):** per target and evaluation-repeat outer fold k: 100 replicates; each
  draws |T_k| rows with replacement from fold k's outer-training rows only (asserted: held-out rows never enter the
  pool), cross-fits 3 internal folds **grouped by patient** (bootstrap copies never straddle a split; asserted), fits
  Platt on those cross-fitted logits (a ≤ 0 → replicate invalid, logged), refits fold k's selected configuration once
  on the whole replicate, and predicts every held-out patient. Hyperparameters are never re-tuned; t_op is unchanged.
  Interval = 10th–90th percentile, shown only with ≥ 80 valid replicates. `scripts/stability.py` →
  `results/stability.json` (20 folds, 98–100 valid replicates each; ~8,000 fits; 20 min wall time, dominated by the
  one EBM fold).
- **Effect:** an interval that straddles t_op adds the reason **"unstable"** and forces LOW model confidence for that
  dataset patient. Crossings: CAD 63, LAD 95, LCX 201, RCA 158 of 303. Only CAD has HIGH regions in the evaluation
  repeat, so the visible change is that **27 of 187 HIGH-confidence CAD patients (14%) become LOW**. Median interval
  width (p90 − p10): CAD 0.15, vessels 0.22–0.26. The Why panel shows "Model stability interval: a–b (10th–90th
  percentile of n valid refits)" with a tooltip that it measures model stability, not the patient's true risk.
- **Scope:** dataset (OOF) patients only, as the plan specifies; new cases have no interval (it would need refits at
  request time). Table 2's tier metrics remain those of the threshold regions; "unstable" only removes patients from
  HIGH, so a displayed HIGH tier is a subset of the region whose PPV/NPV is quoted.
- **Versioning:** models, calibrators, thresholds and all 24 final-model golden predictions are byte-identical to
  v1.0.0 (checked), and no OOF probability changed, so this is a **patch release, v1.0.1**. v1.0.0 stays in the
  registry (retired) and its nested-CV evaluation remains the official result. v1.1.0+ is reserved for learning-loop
  candidates.

## D-018 — Governed learning loop (plan §12B) implemented; replay study

- **Date:** 2026-10-07
- **Status:** DECIDED
- **Implemented:** `ml/novarion_ml/lifecycle/` (package, verify, gate, procedure, candidate, promote, replay, log) +
  `scripts/lifecycle.py` (CLI; `make verify-outcomes / candidate / promote / reject / rollback / verify-log`) +
  `config/promotion_gate.yaml` + `config/replay.yaml` (both written before any run) + Model Center screen + outcome
  recording and learning-package export in the browser. 14 pytest cases (`tests/test_lifecycle.py`) including an
  end-to-end verify → candidate → reject → PASS → promote → rollback drill, and 3 vitest cases for the browser side.
- **Trust boundary:** the browser can only write `pending`; the package parser ignores any status in case JSON and
  rejects the whole file if a field outside the allowlist appears. Eligibility comes only from the steward's
  verification manifest, whose hash must appear in the lifecycle log. Temporal eligibility is a manual steward
  attestation (`temporal_evidence_ref`) — there is no automated time source in v1.
- **Choices the plan left open:**
  - **Incomplete inputs are not eligible.** A training example must have every feature measured (no Unknown values);
    the UI blocks recording otherwise and says why. Imputing training rows would mix two kinds of evidence.
  - **A copy of a training row is flagged** (`input_matches_training_row`) and needs `provenance_confirmed`, like a
    duplicate across learning records.
  - **What promotion changes:** only the four final (new-case) models, refit from the frozen gated configuration on
    303 + all eligible rows, with Platt and thresholds from cross-fitted margins of that set. Dataset patients keep
    their OOF analyses from the frozen v1.0 nested CV; ReferenceContexts (imputation, similar patients, comparisons,
    ledger) stay the public 303-patient cohort, so learning rows are training-only and never shown as "similar
    patients"; the cohort evaluation context stays v1.0's Table 2. All of this is written into the promoted
    manifest's `lineage`, and the Model Center labels gate metrics "pre-promotion validation evidence".
  - **Deployment after promote/rollback is a restart** (`docker compose restart backend`); the registry pointer is
    written atomically and the Model Center shows "deployed bundle vX: restart pending" if they differ. The plan's
    in-process handle swap is not implemented.
  - **"All tests pass"** is evaluated by the CLI (leakage, core ML, contract, anatomy, lifecycle suites) and recorded
    in the gate report; a failure turns PASS into FAIL.
- **Replay (research demonstration):** the replay procedure searches the **LR + XGBoost** part of the grid (56 of 92
  configurations; 19 of the 20 fold selections and all four deployed models), a documented compute reduction allowed
  by the plan. On PASS the champion becomes the challenger itself (the procedure already ends with the refit on the
  same rows). Results in `results/replay.json` and `registry/replay.json` (served at `GET /models/replay`).
- **Replay results (10 arrival orders; AUC of the step model on the next 50 arrivals, mean ± SD across orders):**
  CAD 0.910 ± 0.050 (153 patients) → 0.924 ± 0.044 (203) → 0.922 ± 0.035 (253); LAD 0.821 → 0.846 → 0.826;
  LCX 0.671 → 0.695 → 0.714; RCA 0.731 → 0.752 → 0.730 (SDs 0.03–0.08). Only LCX shows a consistent upward trend;
  the other targets plateau within the across-order spread. Gates: **1 PASS of 20** (gate 1: 1/10, gate 2: 0/10);
  the most frequent failing rule is the ΔAUC 95% CI lower bound ≤ −0.05 (LCX 16, LAD 12, RCA 12 of 20 gates) — with
  50-patient holdouts the paired CI is wide, so the gate is conservative by design, as the plan anticipated. Wall
  time 20 min (8.7 min of fits on 11 workers; the rest is 2,000-replicate paired bootstraps).

## D-019 — Integrating PR #1 (external audit by MysteryMindz) → bundle v1.0.2

- **Date:** 2026-10-12
- **Status:** DECIDED
- **Context:** PR #1 (`nikil/progress-audit`, 4 commits) audited the original snapshot `f0d531b` and fixed real
  defects. It conflicted with the current `main` in 6 files and assumed the trained artifacts were unavailable, so it
  was ported commit by commit rather than merged. Co-authorship is credited in each ported commit; the audit write-ups
  are kept in `docs/audit/`.
- **Integrated:**
  - impossible numeric magnitudes, non-finite JSON numbers, deep JSON and oversized Content-Length values now return
    validation envelopes instead of HTTP 500;
  - Platt calibration rejects separated or constant margins and optimizer failures; an undefined calibration slope
    is NA;
  - a HIGH region without outer-validation evidence degrades to LOW (`no_validation_evidence`) instead of raising;
  - bundle startup checks the feature/target config hashes (CRLF-tolerant) and the registry identity; stale or
    mismatched fold records are rejected before evaluation and bundling;
  - frontend: prefill race and failure states, edits clear the old prediction until the new one arrives, incomplete
    or non-JSON responses are errors, 3D-asset failure is contained, keyboard shortcuts ignore form controls,
    narrow-screen layout, clearer confidence wording, quality notices on the cards;
  - 3 Python test modules and 2 Playwright suites (10 flows).
- **The fold-safe evidence ledger (their most important finding):** fold k's reference patients were binned by
  evaluation-repeat OOF scores from *other* folds' models, whose training data included fold k's held-out patients,
  so a patient's own label could indirectly shape their evidence band. Ledgers now use fold k's own inner
  cross-fitted scores. Instead of retraining, `scripts/fold_ledger_oof.py` recomputes those scores for the frozen
  v1.0 fits (only the selected configuration per fold); refitting Platt on them reproduces every stored fold
  calibration exactly (max |Δ| = 0). Bundle **v1.0.2**: models, probabilities and golden predictions identical to
  v1.0.1, so it is a patch release; the positive-label rate in the evidence band moved by a median of 2.4 points
  (max 19). Older bundles withhold the ledger when served.
- **Table 2b (their recommendation):** `scripts/displayed_tiers.py` measures the HIGH badge as displayed, after the
  unknown-input, atypical and stability gates. CAD: 44.6% of patients HIGH-positive at PPV 98.5% [96.2–100], versus
  the threshold region's 62% at PPV 95%. Vessels: 100% LOW.
- **Adapted or not taken:**
  - **No code fingerprint in the training cache key.** It hashed every file under `ml/` plus `uv.lock`, so any edit
    (even to the learning loop) would invalidate all fits and force a ~2 h retrain. The identity checks are kept; a
    change to training code needs an explicit rerun, and the golden prediction set catches changed outputs.
  - Their evaluation dashboard duplicates the Model Evidence page (which also has ROC/PR/reliability/threshold-sweep
    figures), so it was not ported; its integrity ideas are covered by the strict contract.
  - Version names: their "v0.1.1" corrected build corresponds to v1.0.2 here.
- **Ideas recorded for later (their deep audit):** an OOF failure explorer (TP/TN/FP/FN → patients, opened in 3D), a
  subgroup performance explorer, and a "human-first" educational review mode.

## D-020 — Verification gates (plan Days 15–19) and Tier 3

- **Date:** 2026-10-13
- **Status:** DECIDED
- **CI made trustworthy:** GitHub's e2e job failed after the first push. The causes were real defects, not just flaky
  tests:
  1. a colour-contrast failure (4.36:1) in the no-WebGL 2D fallback, which GPU-less runners hit;
  2. a draft-autosave window that could lose the last edit before a reload.

  Both are fixed. Timing-sensitive tests were made deterministic, CI runs browsers on one worker, and Playwright
  failures are now reported as GitHub annotations with the HTML report uploaded on failure.
- **Local storage safety net (plan §11A):**
  - automatic backups go to a separate IndexedDB database (last 3, in the re-importable export format): after every
    committed case write, before a delete, and of the raw store before a schema upgrade;
  - an unopenable store is reported and never deleted, downgraded or overwritten, and damaged records are hidden
    and counted;
  - storage-full errors explain how to free space, and cases can be deleted with a two-step confirmation.
- **Performance and memory (`results/perf.json`):**
  - real API RSS: 178 MB after start, 184 MB peak under 303 patient loads plus 400 mixed requests;
  - offline bundle: 3.5 MB gzipped, against the 25 MB budget; patient files up to 99 KB, against 200 KB
    (`tests/test_budgets.py` enforces the budgets);
  - JS heap: 7.9 → 12.8 MB after opening 30 patients in offline mode, on a production build.
- **Further checks:**
  - 48 mixed requests on 12 threads equal the sequential results exactly;
  - security headers are present on every response;
  - every browser request stays same-origin, and no service worker is registered;
  - a release secret scan (`scripts/secret_scan.py`) runs in the test suite, with tests that prove it detects
    planted samples;
  - a release manifest generator (`scripts/release_manifest.py`).
- **Fresh-clone reproduction (plan Days 18–19): passed.** A full `make reproduce` on a fresh GitHub clone took 229 min
  on this laptop: fresh UCI download (checksum verified), nested CV, final models, evaluation, stability, bundle and
  replay. It matched this checkout exactly on every check in `scripts/compare_reproduction.py`
  (`results/reproduction.json`):
  - all 100 outer folds and their selected configurations;
  - the deployed configurations;
  - Tables 1–2;
  - the 24 golden predictions;
  - the stability intervals and the replay study.

  The maximum difference was 0. The D-019 recomputed fold scores also equal the scores a real retrain stores.
- **Line-ending defect found by the reproduction:** config hashes were taken over raw bytes, so a Windows (CRLF) and a
  Linux (LF) checkout of the same commit got different train-config, split-manifest and cache-key hashes. Fixes:
  - text provenance hashes now use LF-normalized content (`novarion_ml/hashing.py`), identical for LF files;
  - `.gitattributes` checks text out as LF everywhere;
  - `scripts/migrate_cache_key.py` re-stamped the 105 stored records. It did so only after proving that each was
    produced from the current config content (stored key = the old raw-byte key of today's files);
  - a dry-run bundle build reproduces v1.0.2's golden set.
- **Tier 3 (built because Tiers 1, 1P and 2 are complete):**
  - **what-if sensitivity / ICE** (`POST /sensitivity`):
    - pinned to final-model analyses; dataset patients keep their OOF model;
    - one input varied across its observed training range, through the real canonicalization;
    - age and sex locked;
    - wording: "Model sensitivity, not treatment simulation";
  - **input-uncertainty**: Unknown inputs whose plausible values could flip the predicted class, listed as "Inputs
    that materially affect this model output";
  - **model agreement** (Table 3b): when the four families disagree, the selected model errs far more often (CAD 35%
    vs 9%, LAD 46% vs 19%);
  - **stability visual** on the target cards;
  - **local-only Promote wrapper**: an admin token, the same CLI as `make promote`, and no route in hosted builds.
- **Tier 3 deliberately not built:**
  - conformal prediction (marked experimental in the plan);
  - the ensemble benchmark (the plan rules out new ML sophistication).

## D-021 — Clinical-standard evaluation, prompted by an umbrella review of cardiovascular AI

- **Date:** 2026-10-13
- **Status:** DECIDED
- **Context:** Parizad et al. (*Vasc Health Risk Manag* 2026) review 48 studies of AI for cardiovascular risk
  prediction. It is a literature review, not a system, but it names the field's recurring reporting gaps:
  - comparison with traditional clinical scores;
  - calibration beyond AUC;
  - fairness and subgroup analysis;
  - clinical utility;
  - transparent reporting (TRIPOD-AI);
  - external validation.

  We already covered calibration and explainability. Its headline numbers are internally inconsistent, so we cite
  it for its qualitative conclusions only.
- **Added (no model, threshold, API or prediction change), via `scripts/clinical_evaluation.py`, on the frozen
  out-of-fold predictions:**
  - **A guideline comparator for CAD.** The updated Diamond–Forrester pretest probability (ESC 2013, from Genders et
    al. 2011; ≥ 50% stenosis), applied as published, and the same three inputs refit inside the same outer folds. On
    the 273 patients with a chest-pain type:
    - AUC 0.935 vs 0.852, ΔAUC +0.083 [0.042, 0.127]; vs the refit 0.890, ΔAUC +0.045 [0.012, 0.083];
    - continuous NRI ≈ +1.0 and IDI +0.12 to +0.29;
    - calibration-in-the-large +0.013 (NOVARION) vs +0.158 (published score);
    - the published score leaves 89% of patients in the ESC intermediate band (15–85%), NOVARION 27%.

    The bands are reported descriptively, and the 30 patients without chest pain are outside the published table.
    The transcribed table is unit-tested against published values.
  - **Subgroups** (sex; age < 50, 50–64, ≥ 65) for all four targets: AUC with a bootstrap CI, sensitivity,
    specificity and calibration-in-the-large, with suppression below 10 per class. The honest finding is weaker
    discrimination in patients aged 65 and over (CAD 0.88, LAD 0.70, LCX 0.59, RCA 0.69), with wide intervals. No
    fairness claim is made.
  - **Expected calibration error and decision-curve net benefit**, reported as research metrics with no
    recommendation.
  - **Where it shows:** Tables 6–8 in `results/tables.md`, a "versus the guideline pretest score" and subgroup
    section on the Model Evidence page (static file, works offline), a report paragraph with Table 6, and
    `docs/tripod_ai.md`, which maps every TRIPOD+AI item with its status and the gaps stated plainly.
- **Release:** the model, bundle and API are unchanged, so the model stays v1.0.2. These are evidence and
  documentation additions on top of the v1.0.2 release commit.

## D-022 — Sign-in and a simpler, tabbed interface

- **Date:** 2026-10-13
- **Status:** DECIDED
- **Context:** In review, one screen showed the patient list, all 54 inputs, the 3D view, four full prediction cards,
  the explanation and what-if together, and the team found it too dense to read. The user also asked for a sign-in
  page with real username + password accounts.
- **Decision (interface; no model, threshold or prediction change):**
  - Sign-in page → home with one large NEW CASE button → top navigation (Home, New case, Dataset library, My cases,
    Model evidence, Model center).
  - An open case has four tabs: **Result** (3D heart, a two-line summary, one line per target that expands on
    click), **Why** (explanation, or all targets compared), **Patient data** (positive findings and measurements
    first, all inputs on request; the New case form with a live summary beside it) and **What-if**.
  - Tabs are hidden, not unmounted, so the New case form keeps its values and its live prediction.
  - Reasons from the patient's own inputs (an UNKNOWN input, an atypical profile) stay visible on the collapsed card.
    Model-level reasons are shown when the card is opened.
  - The header status chips (live backend, model version, dataset) are removed. The mock and offline chips remain,
    because they change what the numbers mean. The disclaimer moves from a banner to a one-line footer on every
    screen, including the sign-in page (brief item 5).
  - Secondary greys are one shade darker and body text is medium weight, for legibility.
  - Model evidence gets section tabs (Summary · Performance · Confidence tiers · Curves · vs guideline score). Summary
    shows the selected target's ROC-AUC, sensitivity, specificity, PPV and NPV as large numbers. Table 1 shows those
    plus the Brier score by default (rates as percentages, mean bold with ± SD beneath); all 12 metrics and the
    trivial baselines are behind toggles. A takeaway line states the finding the close rows carry: the model types
    perform about the same, a claim made only when the AUC gap is smaller than every fold-to-fold SD, and the
    selection rule picked the simplest family.
- **Decision (sign-in):**
  - Accounts live in `artifacts/users.json` (gitignored; `NOVARION_USERS_FILE` overrides) and are managed with
    `scripts/users.py add|remove|list`. They are stored as salted scrypt hashes (N = 2^14, r = 8, p = 1), never as
    passwords.
  - The file existing turns sign-in on; with no file, or with `NOVARION_AUTH=off`, the API stays open, so dev and
    test setups need nothing.
  - With sign-in on, every `/api/v1` route except health, the three `/auth/*` routes and the API description
    returns 401 `UNAUTHENTICATED` without a valid session.
  - The session cookie is HttpOnly and SameSite=Strict, scoped to `/api/v1`, lasts 8 h and is held in memory, so a
    restart signs everyone out. Set `NOVARION_COOKIE_SECURE=1` behind HTTPS.
  - Wrong passwords, unknown users and malformed names get the same answer. Unknown users still cost one scrypt, so
    timing does not reveal valid names. Five failures lock that username for 60 s, on top of the per-client rate
    limit.
  - Offline demo mode has no backend to check a password against, so it needs no sign-in. It shows only the
    precomputed public-dataset results.
- **Verification:** `tests/test_auth.py` covers the open/closed switch, a 401 on every route, the cookie flags,
  revocation, identical failure answers, lockout and expiry, and hashes never being passwords. `e2e/auth.spec.ts`
  covers the sign-in page, sign-out, expired sessions and axe. The E2E flows were updated for the tabbed layout,
  and axe now also checks the home page, the library and every case tab.
- **Release:** a frontend and API change (new `/auth/*` endpoints, new error codes), so it ships as v1.0.3. The
  model and bundle are unchanged.

## D-023 — One workspace per open patient, with search

- **Date:** 2026-10-13
- **Status:** DECIDED
- **Context:** After D-022 only one case could be open at a time. Opening another patient replaced the first, and an
  unsaved New case was lost on leaving it. The user asked for one workspace per patient and a search bar, because
  with many open workspaces a patient is hard to find.
- **Decision (interface only; no model, threshold, prediction or API change):**
  - Every dataset patient, New case and case reopened from My cases opens in its own workspace. Opening something
    already open focuses it instead of duplicating it. Each New case is a separate workspace ("New case 1", "New case
    2"), named by its case number once saved.
  - A bar under the header lists the open workspaces with a close button each. Closing the active one shows its
    neighbour; closing the last returns home. Its search box matches the ID, the case number, the kind, and for
    dataset patients their sex, age and risk factors. A typed patient ID ("6", "ZAS-0006") always offers that
    patient, even when it also matches someone's age.
  - **State per workspace:** the active case lives in the store's flat fields, so every panel reads it as before.
    Switching parks it in its workspace entry and restores the other.
  - **New case forms:** every open New case form stays mounted while hidden, so typed values survive switching. Its
    results are written to its own workspace (`commitToWorkspace`) even when another patient is on screen. A late
    prediction can therefore never land in the visible case, and it is not lost either; this replaces the old "discard
    on leave" rule.
  - The workspace screen stays mounted (hidden) on the other pages. The 3D canvas renders on demand, so this costs
    nothing while it is hidden.
  - **Drafts:** the single unsaved-draft slot is offered only to the first New case of a session.
  - **Stored cases:** reopening one from My cases always rereads it from storage.
  - **Deletion:** deleting a case closes its workspace, and any other workspace that had saved into it becomes
    unsaved again.
- **Verification:** `e2e/workspaces.spec.ts` covers per-workspace tab and selection, no duplicates, a New case keeping
  its values while other patients are viewed, search by ID or details and opening from search, and closing. The
  updated `flow-b-safety` test holds a New case prediction in flight, switches to another patient, then checks that
  the response leaves the visible case untouched and arrives in its own workspace.


## D-024 — Confidence tiers renamed for what they mean; the tested accuracy shown beside them

- **Date:** 2026-10-13
- **Status:** DECIDED
- **Context:** On screen nearly every prediction read "LOW MODEL CONFIDENCE": every vessel prediction (no vessel
  region qualified, D-008) and every negative CAD call. The user found that "LOW" reads as "this model is bad". It
  actually means "outside the score ranges that met the pre-registered PPV ≥ 90% / NPV ≥ 95% target". The
  predictions themselves are ordinary model predictions with the model's measured out-of-sample performance.
- **Rejected:** lowering the pre-registered targets so that more predictions qualify. Moving a target after seeing
  results would undo D-008, and it is the first thing a methods reviewer checks.
- **Decision (wording and display only; the model, thresholds, confidence regions, API values `high`/`low`,
  anatomy configuration and pinned hashes are unchanged):**
  - The tiers are labelled **VALIDATED HIGH CONFIDENCE** and **STANDARD CONFIDENCE** everywhere in the app: cards,
    summary, 3D tooltip and callouts, legend, 2D fallback, Review Snapshot PDF, review limitations and the Model
    evidence Table 2 headers.
  - Each prediction line shows how the model did in testing. A validated range shows its own measured PPV or NPV
    ("PPV 95% in this range in testing"); a standard prediction shows the target model's out-of-sample ROC-AUC ("LAD
    model ROC-AUC 0.84 in testing"). Both come from validation, never from the patient. The figure is omitted when no
    validated model row exists (the contract mock).
  - The standard tier keeps its lower-chroma colour (config unchanged). The 3D stripe pattern drops from 30% to 12%
    strength, and the dashed badge and ring are replaced by a plain neutral badge: a tier, not a warning. Validated is
    shown in dark green.
  - The report and model card keep HIGH/LOW as the technical names, with the mapping stated once.
- **Release:** a UI change after v1.0.3, so it ships as release v1.0.4, still serving model v1.0.2.
