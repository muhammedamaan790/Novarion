"""API latency benchmark (plan §11 "Latency": p95 < 200 ms for /predict on the local reference machine) → results/perf.json.

Sequential requests (one client, paced below the rate limit) against a running stack — by default the Docker stack
on :8080. Inputs rotate through real dataset profiles so every request is a fresh computation.
Usage: uv run --group inference python scripts/benchmark_api.py [--base http://127.0.0.1:8080] [--n 100]
"""

from __future__ import annotations

import json
import os
import platform
import statistics
import sys
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
BUDGET_P95_MS = {"predict": 200}


def arg(name: str, default: str) -> str:
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


def percentile(values: list[float], q: float) -> float:
    ordered = sorted(values)
    k = (len(ordered) - 1) * q
    lo, hi = int(k), min(int(k) + 1, len(ordered) - 1)
    return ordered[lo] + (ordered[hi] - ordered[lo]) * (k - lo)


def main() -> None:
    base = arg("--base", "http://127.0.0.1:8080").rstrip("/") + "/api/v1"
    n = int(arg("--n", "100"))
    pace = 0.12  # ≤ ~8 requests/s: below the 600/min limit, so throttling never pollutes the numbers
    client = httpx.Client(timeout=30)
    meta = client.get(f"{base}/meta").json()
    entered = [f["id"] for f in meta["features"] if f["input_mode"] == "entered"]
    patients = client.get(f"{base}/patients").json()["patients"]
    profiles = []
    for p in patients[:n]:
        bundle = client.get(f"{base}/patients/{p['patient_id']}").json()
        profiles.append({k: bundle["canonical_inputs"][k] for k in entered})

    def body(i: int, **extra) -> dict:
        return {"request_id": str(uuid.uuid4()), "api_schema_version": "1.0.0", "inputs": profiles[i % len(profiles)],
                **extra}

    results: dict[str, list[float]] = {"predict": [], "validate": [], "analyze_full": [], "explain": [],
                                       "patient_bundle": []}
    for i in range(n):
        for name, timings in results.items():
            time.sleep(pace)
            t0 = time.perf_counter()
            if name == "predict":
                r = client.post(f"{base}/predict", json=body(i, input_revision=i))
                last_predict = r.json()
            elif name == "validate":
                r = client.post(f"{base}/validate", json=body(i, input_revision=i))
            elif name == "analyze_full":
                r = client.post(f"{base}/analyze/full", json=body(i))
            elif name == "explain":
                r = client.post(f"{base}/explain", json=body(i, analysis_id=last_predict["analysis_id"],
                                input_sha256=last_predict["input_sha256"], target="lad",
                                model_version=last_predict["model_version"],
                                artifact_manifest_sha256=last_predict["artifact_manifest_sha256"]))
            else:
                r = client.get(f"{base}/patients/{patients[i % len(patients)]['patient_id']}")
            elapsed = (time.perf_counter() - t0) * 1000
            if r.status_code != 200:
                raise SystemExit(f"{name} returned {r.status_code}: {r.text[:200]}")
            timings.append(elapsed)
    summary = {
        name: {"n": len(v), "p50_ms": round(percentile(v, 0.5), 1), "p95_ms": round(percentile(v, 0.95), 1),
               "max_ms": round(max(v), 1), "mean_ms": round(statistics.mean(v), 1),
               **({"budget_p95_ms": BUDGET_P95_MS[name], "within_budget": percentile(v, 0.95) < BUDGET_P95_MS[name]}
                  if name in BUDGET_P95_MS else {})}
        for name, v in results.items()
    }
    report = {
        "measured_at": datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "target": base, "model_version": meta["model_version"], "client": "sequential, paced ~8 req/s, one connection",
        "machine": {"os": platform.platform(), "cpu": platform.processor() or platform.machine(),
                    "logical_cpus": os.cpu_count(), "python_client": platform.python_version()},
        "endpoints": summary,
    }
    perf_path = ROOT / "results" / "perf.json"
    existing = json.loads(perf_path.read_text(encoding="utf-8")) if perf_path.exists() else {}
    existing["api"] = report
    perf_path.write_text(json.dumps(existing, indent=1) + "\n", encoding="utf-8")
    for name, s in summary.items():
        print(f"{name:15s} p50 {s['p50_ms']:7.1f} ms  p95 {s['p95_ms']:7.1f} ms  max {s['max_ms']:7.1f} ms")


if __name__ == "__main__":
    main()
