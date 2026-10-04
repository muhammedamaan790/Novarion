# NOVARION — reproducible pipeline (plan §15). Windows: run the same commands from README in PowerShell/Git Bash.
UV := uv run

.PHONY: data contracts train bundle reproduce test serve mock frontend e2e

data:          ## download UCI #411 (checksum-verified) + data verification report
	$(UV) python scripts/download_data.py
	$(UV) python scripts/profile_dataset.py

contracts:     ## regenerate contracts/ (OpenAPI + mocks) from the Pydantic schemas
	$(UV) --group inference python scripts/build_contracts.py

train:         ## nested CV + evaluation + final models (cached per fold; ~1.5 h on 10 cores)
	$(UV) --group train python scripts/train.py all

bundle:        ## versioned model bundle + OOF demo bundle + registry pointer
	$(UV) --group train python scripts/build_bundle.py

reproduce: data train bundle   ## download → train → evaluate → export

test:
	$(UV) --group train --group inference --group assets pytest -q

serve:         ## real API on :8000 (fails closed without a verified bundle)
	PYTHONPATH=ml $(UV) --group inference uvicorn app.main:app --app-dir backend --port 8000

mock:          ## contract mock API on :8000 (model 0.0.0, NOT a model)
	NOVARION_MOCK=1 PYTHONPATH=ml $(UV) --group inference uvicorn app.main:app --app-dir backend --port 8000

frontend:
	cd frontend && npm run dev

e2e:
	cd frontend && npx playwright test
