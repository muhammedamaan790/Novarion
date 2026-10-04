# NOVARION

**A new light on every coronary artery.** Coronary case-review system — Multimodal AI Hackathon 2026, Track A.

> ⚠️ **Decision support / educational purposes only. Not a substitute for formal diagnostic imaging.**
> Predictions estimate the probability of the dataset's CAD / ≥50% vessel-stenosis labels from routine clinical
> features. They are not diagnoses, do not locate lesions, and do not recommend tests or treatment.

## Status

| Component | Status |
|---|---|
| Specification (master plan) | Specified |
| Data download + checksum pin | **Implemented** |
| Day-2 data verification (`data/schema_report.json`) | **Implemented** |
| Feature registry + canonical loader + leakage guard | **Implemented** (unit tests pass) |
| 3D anatomy asset (`heart.glb`, `anatomy_manifest.json`, `anatomy_map.json`, pinned label anchors) | **Implemented** (QA tests pass) |
| API contract v0 (`backend/app/schemas.py` → `contracts/openapi.json`), strict JSON, error envelope | **Implemented** (contract tests pass) |
| Contract mocks (`contracts/mock_*.json`, `NOVARION_MOCK=1` server) | **Implemented** — toy engine, model `0.0.0`, *not a model* (D-006) |
| Canonical `input_sha256` + 50 frozen golden vectors + train/serve parity | **Implemented** |
| Training pipeline: registry encoder, 92-config grid, nested CV (5×5 outer, 5 inner), 1-SE selection, Platt (a > 0 guard), Layer A/B thresholds, final models | **Implemented** (`scripts/train.py`; ML unit tests pass) |
| Evaluation: Table 1 (25 outer folds, baselines, family benchmarks), Table 2 (confidence tiers, bootstrap CIs), leaderboard | **Implemented** (`results/metrics.json`, `results/leaderboard.csv`) |
| Explanations (exactly additive, calibrated log-odds), ReferenceContext (imputation, Gower kNN, atypical, cohort comparisons, ledger) | **Implemented** |
| Versioned model bundle + OOF demo bundle (303 patients) + non-circular manifests + registry pointer | **Implemented** (`scripts/build_bundle.py`; integrity + tamper tests) |
| Real API (`BundleService`): startup integrity, `/predict`, `/analyze/full`, `/explain`, `/evidence`, `/validate`, `/patients`, `/evaluation` | **Implemented** (fails closed without a verified bundle) |
| Frontend V0: 3D heart, probability colouring + recolour easing + LOW hatch, 3D ↔ panel selection, presets, isolation, cards, Why panel, deep links, keyboard, **new-case registry form with live prediction** | **Implemented** (Playwright Flow A + Flow B, mock and real backend) |
| CI (GitHub Actions), Docker skeleton (`docker-compose.yml`), `Makefile` | **Implemented** — Docker not yet verified (engine was not running) |
| Case workflow (CaseStore/IndexedDB, import, review, snapshot, history), stability bootstrap, learning loop, Model Center | Specified (not yet implemented) |

## Results (development bundle v0.1.0 · nested CV, 5 × 5 outer folds · full tables: `results/tables.md`)

| Target | Prevalence | ROC-AUC (outer-fold mean ± SD) | Balanced accuracy | Brier | High-confidence share (pooled OOF) |
|---|---|---|---|---|---|
| CAD | 71.3% | 0.930 ± 0.035 | 0.860 ± 0.051 | 0.095 | 62% high-positive (PPV 95%), 38% LOW |
| LAD | 58.4% | 0.838 ± 0.046 | 0.758 ± 0.044 | 0.161 | 100% LOW (no qualified region) |
| LCX | 39.3% | 0.721 ± 0.067 | 0.666 ± 0.067 | 0.209 | 100% LOW (no qualified region) |
| RCA | 37.6% | 0.736 ± 0.037 | 0.666 ± 0.042 | 0.200 | 100% LOW (no qualified region) |

Every prediction is still a binary STENOSIS / NO STENOSIS call; LOW means the score is outside a region that met the
pre-registered PPV ≥ 0.90 / NPV ≥ 0.95 Wilson bound in training-side validation (targets fixed before results, D-008).
Reproduce: `make reproduce` (≈ 1.5 h on 10 CPU cores; ~2.75 h wall here because the laptop slept mid-run).

Nothing is called "working" until it reaches **Verified** (E2E flows + fresh-clone + second-machine + performance tests).

## Quick start (current)

```bash
uv python install 3.11
uv sync
uv run python scripts/download_data.py     # downloads UCI #411 and verifies the pinned SHA-256
uv run python scripts/profile_dataset.py   # writes data/schema_report.json (single source of truth for data facts)
uv run --group assets python scripts/build_anatomy.py   # needs BodyParts3D files in data/raw/bodyparts3d/ (see CREDITS.md)
uv run --group inference python scripts/build_contracts.py   # regenerates contracts/ (deterministic)
uv run --group inference --group assets pytest -q
```

Mock API for frontend / 3D work (contract-valid, input-dependent, **not a model**):

```bash
NOVARION_MOCK=1 NOVARION_CORS_ORIGINS=http://localhost:5173 PYTHONPATH=ml uv run --group inference uvicorn app.main:app --app-dir backend --port 8000
curl -s -X POST localhost:8000/api/v1/predict -H 'Content-Type: application/json' -d @contracts/sample_patient.json
```

Without `NOVARION_MOCK=1` and without a verified model bundle, the API fails closed (`/health/ready` → 503).

Frontend (Node 22+; React 19 + React Three Fiber 9, Vite, Tailwind; types generated from `contracts/openapi.json`):

```bash
cd frontend
npm ci
npm run dev                 # http://localhost:5173 (proxies /api to :8000 — start the mock API above first)
npm run check:api           # generated API types match the contract
npm run typecheck && npm run lint && npm test
npx playwright test         # E2E Flow A; starts the mock API + dev server itself (uses system Edge; PW_CHANNEL=chrome)
```

## Data

Extension of Z-Alizadeh Sani dataset, UCI Machine Learning Repository #411, CC BY 4.0.
Verified: 303 records × 59 columns (55 predictors + labels Cath, LAD, LCX, RCA); no missing values.
See `docs/decisions.md` for data decisions (e.g., D-001).

## Credits

Dataset and 3D anatomy licences (CC BY 4.0) and attribution: see `CREDITS.md`.
