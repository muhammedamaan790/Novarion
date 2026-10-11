# Novarion: contributor audit and starting plan

Reviewed on 11 October 2026 against main commit `f0d531b3fd11e1c608c515d5080c3d3474effdef`.
Contributor branch: `nikil/progress-audit`.

## Conclusion

Keep the existing implementation. It contains a substantial data/ML pipeline, a typed backend, and an interactive anatomical heart dashboard. The first contribution is to make this existing loop reliable and reproducible. Adding a learning loop or redesigning the whole app should wait until the official submission works from another machine.

The supplied master plan is design background, not evidence that every feature exists. Its one-person team allocation is stale for the current two-person team. Recommendations below are provisional ownership suggestions, not assignments agreed with the teammate.

## What was verified

| Area | Current evidence | Boundary |
|---|---|---|
| Dataset | Official UCI archive downloaded; workbook checksum matches the pinned `739343245c2ba578b541370217531750d8e936022f928b83e0d91756caa3ff0b` | 303 rows, 59 columns, 55 predictors and four labels; no missing values |
| Leakage controls | Data/registry tests pass; Cath/CAD/LAD/LCX/RCA are excluded from predictors; derived-feature lineage is checked | Tests and source review, not an independent rerun of the full training experiment |
| ML implementation | Nested cross-validation, fold-local encoders, calibration, thresholds, and four model families exist; additive explanation tests pass | Full training and reported performance have not been reproduced on this machine |
| Model results | `results/metrics.json`, `results/tables.md`, and `results/leaderboard.csv` are committed | Repository-reported results: CAD AUC 0.930, LAD 0.838, LCX 0.721, RCA 0.736; outer-fold means, not independently reproduced metrics |
| Real backend | Bundle verification and serving code exist; fresh-clone readiness correctly returns HTTP 503 when weights are absent | Real `/predict`, OOF bundles, and the real-model test suite remain unverified locally |
| Anatomy | Committed BodyParts3D heart asset, named vessels, mapping, attribution, and anatomy tests | Reference anatomy; no patient-specific reconstruction or lesion localization |
| Browser workflow | Mock backend: dataset/new-case flows, target cards, vessel picking, camera presets, explanation loading, keyboard shortcuts, deep links, and label reveal pass | Mock outputs are synthetic; this does not establish predictive performance |
| Safety wording | Persistent disclaimer and visible `MOCK DATA - NOT A MODEL` badge inspected | No external clinical validation claimed |
| Frontend checks | API-type sync, TypeScript, lint, production build, and six colour unit tests pass | Build still warns about an approximately 1.32 MB minified JS chunk |
| Python checks | 107 tests pass, Ruff passes | One module-level skip excludes the entire trained-bundle suite; one dependency deprecation warning |
| Browser checks | Nine tests pass on Windows using Edge and the mock backend | Two added regression tests failed before the fix and pass afterward |

GitHub's single existing CI run on the initial main commit succeeded. Its browser job uses mocks, and its Python job does not create or download model weights. A green result therefore does not prove that real inference is reproducible. No GitHub release assets were available when checked.

## First contribution on this branch

1. Cancel pending validation/prediction requests on input changes and form unmount. A delayed manual-case response previously recoloured the shared heart after the user switched back to the dataset tab.
2. Clear the previous analysis as soon as inputs change, including when the form becomes empty. Old predictions and colours previously remained visible while the new values awaited validation.
3. Add browser regressions covering both behaviours; both were reproduced on the original implementation.
4. Normalize CRLF/LF in the generated API-type comparison. Windows Git checkout line endings previously caused a false "stale API types" failure.

Training configuration, model thresholds, API schemas, anatomy assets, and the teammate's main branch are unchanged by these fixes.

## Official requirements versus optional scope

The Track A PDF requires four classifiers (CAD, LAD, LCX, RCA), exclusion of label columns from predictors, classification metrics, an interactive colour-coded 3D heart/torso view, matching vessel selection, explanations and measurement contributions, a visible disclaimer, a working integrated web prototype, model code and weights, a report of at most six pages, and a 3-10 minute YouTube demo.

There is no separately supplied long-term event-risk target. Keep the project's explicit framing of overall CAD-label probability and avoid presenting it as a 10-year event or mortality estimate.

Case persistence, import, review notes, snapshots, and history are useful product additions from the supplied plan. The governed learning loop, challenger promotion, Model Center, and replay study are optional plan features, not explicit Track A requirements.

## Missing or not yet verified

- **P0: model handoff.** `registry/models.json` points to `artifacts/models/v0.1.0`, but `artifacts/` is ignored and no release supplies it. Obtain the complete bundle from the teammate or run the locked reproduction pipeline. Preserve original hashes and library versions. Do not replace it with dummy weights.
- **P0: real end-to-end verification.** Once the bundle is available, verify startup hashes and run the real backend and `E2E_BACKEND=real` browser suite. Bundle tests also expect the nested-fold result files under `results/nested/`; request those with the handoff or regenerate them.
- **P1: evaluation screen.** The API and tables exist, but no dedicated frontend evidence/evaluation screen exists. Show all four targets, official metrics, baselines, validation method, and model limitations using backend-provided results.
- **P1: case workflow.** No CaseStore/IndexedDB, import, review, snapshot, or saved history implementation exists. Build these incrementally after the real core works.
- **P1: release deliverables.** No final six-page report or demo-video link is present. No hosted app link or verified Docker run is available from this audit.
- **P1: robustness/performance.** Offline operation, WebGL fallback/context loss, narrow-screen usability, device frame rate, backend latency/RAM, and another-machine reproduction need explicit checks. Docker could not be tested because Docker is unavailable here.
- **P2: further ML and product depth.** Stability bootstrap, ablations, model lifecycle, outcome capture, and replay remain later work. Avoid selecting new models or thresholds based on the existing outer-test results.

## Suggested two-person split

| Owner | Scope | First handoff |
|---|---|---|
| You | Frontend/3D interactions, workflow reliability, evaluation screen, case intake/history/snapshot, browser tests, demo presentation | Small reviewed changes against the existing API contract |
| Friend | Dataset/model artifacts, validation methodology, model explanation correctness, backend, reproducible release bundle | Complete v0.1.0 model/OOF bundle and nested result files; exact startup instructions |
| Together | Real end-to-end checks, report, video, release and submission | One complete patient -> prediction -> coloured vessel -> explanation demo |

Avoid both editing the training configuration, generated API schemas, or the same large frontend component concurrently. Use focused pull requests against main; never force-push main.

## Next 60 minutes

The initial clone, branch, dependency installation, audit, and first reliability fixes are already completed in this workspace.

| Time | Action | Done when |
|---|---|---|
| 0-10 min | Review this audit and agree file/module ownership with your friend | Both know which files they own |
| 10-25 min | Obtain and place the complete model bundle and nested result files | Real readiness returns HTTP 200 with model v0.1.0 and no mock header |
| 25-45 min | Run real bundle checks and dataset/new-case browser flows | Four targets, matching vessel colours, and matching explanations work with real artifacts |
| 45-60 min | Review the reliability changes and choose the next small PR | A defined next task with a clear acceptance check |

If the bundle handoff takes longer, continue frontend work against the explicitly labelled mock. Keep real-model verification pending.

## Next implementation tasks

Estimates assume the current skeleton and are provisional until the deadline and ownership are known.

| Priority | Task | Estimate | Dependency | Acceptance check |
|---|---|---|---|---|
| P0 | Bundle handoff and real checks | 30-90 min with existing artifacts; retraining takes longer | Friend's artifacts or reproduction run | Hashes pass; real Flow A/B and bundle checks pass |
| P1 | Evidence/evaluation page | 2-4 hours | Existing evaluation API; real bundle for final verification | All official metrics, four targets, source/version, baselines and limitations visible |
| P1 | Save/reopen a local case and review note | 3-5 hours | Defined persistence/version handling | Reload preserves inputs; saved results retain model/input provenance; outdated results are visibly handled |
| P1 | Import with quality gate | 2-4 hours | Registry validation and case model | Invalid/missing fields block; supported units/categories are explicit; no silent invented inputs |
| P1 | Review snapshot | 2-4 hours | Stable case model and explanation data | Inputs, predictions, selected vessel, model/version, caveats and disclaimer export together |
| P1 | Release/demo package | Deadline-dependent | Real core verified | Fresh-machine run, report <=6 pages, working 3-10 minute video and judging fallback |

## Windows startup for the prepared local checkout

Use two PowerShell terminals in the repository. The local `.venv` and frontend dependencies have already been installed for this audit.

Terminal 1, explicitly labelled mock mode:

```powershell
$env:PYTHONPATH = 'ml'
$env:NOVARION_MOCK = '1'
.\.venv\Scripts\python.exe -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000
```

Terminal 2:

```powershell
cd frontend
npm.cmd run dev -- --host 127.0.0.1
```

Open `http://127.0.0.1:5173`. After placing the verified real bundle, remove `NOVARION_MOCK` in terminal 1 and restart it:

```powershell
Remove-Item Env:NOVARION_MOCK -ErrorAction SilentlyContinue
```

For a fresh machine, install Python 3.11 and uv, use `uv sync --frozen --group train --group inference --group assets`, download/profile the dataset, and run `npm.cmd ci` in frontend. The checked-in `heart.glb` already exists; rebuilding it is unnecessary for normal frontend setup.

## Sources

- User-supplied `Track A.pdf`: official requirements and scoring (30% prediction, 25% 3D, 20% explanation, 15% integration, 10% implementation).
- User-supplied `now-we-need-a-curried-sundae.md`: intended product scope, priorities and methodology background; not a runtime completion record.
- Repository snapshot: https://github.com/muhammedamaan790/Novarion/tree/f0d531b3fd11e1c608c515d5080c3d3474effdef
- Existing main CI: https://github.com/muhammedamaan790/Novarion/actions/runs/37203728485
- Local data, Python, frontend and Edge checks described above. Screenshots show the labelled mock, not real-model evidence.
