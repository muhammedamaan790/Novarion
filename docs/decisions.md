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
