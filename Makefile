# NOVARION — reproducible pipeline (plan §15). Windows: run the same commands from README in PowerShell/Git Bash.
UV := uv run

.PHONY: data contracts train bundle stability replay reproduce test serve mock frontend e2e docker docker-e2e \n        verify-outcomes candidate promote reject rollback verify-log lifecycle-status

data:          ## download UCI #411 (checksum-verified) + data verification report
	$(UV) python scripts/download_data.py
	$(UV) python scripts/profile_dataset.py

contracts:     ## regenerate contracts/ (OpenAPI + mocks) from the Pydantic schemas
	$(UV) --group inference python scripts/build_contracts.py

train:         ## nested CV + evaluation + final models (cached per fold; ~1.5 h on 10 cores)
	$(UV) --group train python scripts/train.py all

bundle:        ## versioned model bundle + OOF demo bundle + registry pointer + offline copy for the frontend
	$(UV) --group train python scripts/build_bundle.py
	$(UV) --group inference python scripts/export_demo_bundle.py

stability:     ## OOF refit-bootstrap stability intervals (plan §6.10a; ~20 min) → results/stability.json (rebuild the bundle after)
	$(UV) --group train python scripts/stability.py

replay:        ## historical replay study of the governed update process (plan §12B; ~10 min) → registry/replay.json
	$(UV) --group train python scripts/replay.py

reproduce: data train stability bundle replay   ## download → train → evaluate → export

# ---- governed learning loop (plan §12B). CLI-only; every action is appended to registry/lifecycle_log.jsonl ----
LIFECYCLE := $(UV) --group train --group inference python scripts/lifecycle.py

verify-outcomes:  ## steward: make verify-outcomes PACKAGE=pkg.json ATTEST=attest.json STEWARD="name"
	$(LIFECYCLE) verify-outcomes --package $(PACKAGE) --attest $(ATTEST) --steward "$(STEWARD)"

candidate:        ## make candidate PACKAGE=pkg.json VERSION=1.1.0  (forward holdout + challenger + paired gate)
	$(LIFECYCLE) candidate --package $(PACKAGE) --version $(VERSION)

promote:          ## human approval: make promote VERSION=1.1.0 APPROVER="name"  (gate PASS only)
	$(LIFECYCLE) promote --version $(VERSION) --approver "$(APPROVER)"

reject:           ## make reject VERSION=1.1.0 APPROVER="name" REASON="..."
	$(LIFECYCLE) reject --version $(VERSION) --approver "$(APPROVER)" --reason "$(REASON)"

rollback:         ## make rollback VERSION=1.0.1 APPROVER="name"  (restores a whole immutable bundle)
	$(LIFECYCLE) rollback --version $(VERSION) --approver "$(APPROVER)"

verify-log:       ## check the lifecycle log hash chain
	$(LIFECYCLE) verify-log

lifecycle-status:
	$(LIFECYCLE) status

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

docker:        ## build + start the authoritative local stack → http://localhost:8080 (needs a built bundle)
	docker compose up -d --build

docker-e2e:    ## all browser E2E flows against the running Docker stack
	cd frontend && E2E_BACKEND=real E2E_BASE_URL=http://127.0.0.1:8080 npx playwright test
