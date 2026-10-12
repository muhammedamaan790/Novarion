"""Backend memory + offline-bundle sizes → results/perf.json ("memory", "bundle") (plan §11A, Days 18–19).

Starts the real API (production bundle) as a child process on a free port, records its resident memory (RSS,
including any worker children) after startup and the peak while serving a mixed workload: 303 patient bundles,
then /predict, /validate, /analyze/full and /explain on real dataset profiles. Requests are paced below the rate
limit. Also records the offline demo-bundle sizes against their budgets.
Usage: uv run --group inference --group dev python scripts/measure_memory.py [--port 8030] [--n 100]
"""

from __future__ import annotations

import gzip
import json
import os
import socket
import subprocess
import sys
import threading
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path

import httpx
import psutil

ROOT = Path(__file__).resolve().parents[1]


def arg(name: str, default: str) -> str:
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


def rss(proc: psutil.Process) -> int:
    total = 0
    for p in [proc, *proc.children(recursive=True)]:
        try:
            total += p.memory_info().rss
        except psutil.NoSuchProcess:
            pass
    return total


def bundle_sizes() -> dict:
    registry = json.loads((ROOT / "registry" / "models.json").read_text(encoding="utf-8"))
    entry = next(m for m in registry["models"] if m["version"] == registry["production_version"])
    demo = ROOT / entry["path"] / "demo_bundle"
    files = [p for p in demo.rglob("*") if p.is_file()]
    patients = [p.stat().st_size for p in (demo / "patients").glob("*.json")]
    gz = sum(len(gzip.compress(p.read_bytes(), compresslevel=6)) for p in files)
    return {"model_version": entry["version"], "files": len(files),
            "raw_mb": round(sum(p.stat().st_size for p in files) / 1e6, 2), "gzip_mb": round(gz / 1e6, 2),
            "index_kb": round((demo / "index.json").stat().st_size / 1024, 1),
            "patient_kb_max": round(max(patients) / 1024, 1), "patient_kb_median": round(sorted(patients)[len(patients) // 2] / 1024, 1),
            "budgets": {"gzip_mb": 25, "index_kb": 1024, "patient_kb": 200}}


def main() -> None:
    port = int(arg("--port", "8030"))
    n = int(arg("--n", "100"))
    with socket.socket() as s:
        if s.connect_ex(("127.0.0.1", port)) == 0:
            raise SystemExit(f"port {port} is in use; pass --port")
    env = {**os.environ, "PYTHONPATH": "ml", "NOVARION_RATE_LIMIT_PER_MIN": "100000", "NOVARION_RATE_LIMIT_BURST": "100000"}
    server = subprocess.Popen([sys.executable, "-m", "uvicorn", "app.main:app", "--app-dir", "backend", "--port", str(port)],
                              cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    proc = psutil.Process(server.pid)
    base = f"http://127.0.0.1:{port}/api/v1"
    client = httpx.Client(timeout=60)
    try:
        t0 = time.perf_counter()
        while True:
            try:
                if client.get(f"{base}/health/ready").json().get("ready"):
                    break
            except httpx.HTTPError:
                pass
            if time.perf_counter() - t0 > 120:
                raise SystemExit("backend did not become ready")
            time.sleep(0.25)
        ready_s = time.perf_counter() - t0
        time.sleep(1)
        after_start = rss(proc)
        peak = [after_start]
        stop = threading.Event()

        def sample() -> None:
            while not stop.is_set():
                peak[0] = max(peak[0], rss(proc))
                time.sleep(0.05)

        sampler = threading.Thread(target=sample, daemon=True)
        sampler.start()
        meta = client.get(f"{base}/meta").json()
        entered = [f["id"] for f in meta["features"] if f["input_mode"] == "entered"]
        patients = client.get(f"{base}/patients").json()["patients"]
        profiles = []
        for p in patients:  # every patient bundle once
            b = client.get(f"{base}/patients/{p['patient_id']}").json()
            profiles.append({k: b["canonical_inputs"][k] for k in entered})
        for i in range(n):
            body = {"request_id": str(uuid.uuid4()), "api_schema_version": "1.0.0", "inputs": profiles[i % len(profiles)]}
            pred = client.post(f"{base}/predict", json={**body, "input_revision": i}).json()
            client.post(f"{base}/validate", json={**body, "request_id": str(uuid.uuid4()), "input_revision": i})
            client.post(f"{base}/analyze/full", json={**body, "request_id": str(uuid.uuid4())})
            client.post(f"{base}/explain", json={**body, "request_id": str(uuid.uuid4()), "analysis_id": pred["analysis_id"],
                                                 "input_sha256": pred["input_sha256"], "target": "lad",
                                                 "model_version": pred["model_version"],
                                                 "artifact_manifest_sha256": pred["artifact_manifest_sha256"]})
        stop.set()
        sampler.join()
        after_load = rss(proc)
    finally:
        server.terminate()
        try:
            server.wait(10)
        except subprocess.TimeoutExpired:
            server.kill()
    memory = {
        "measured_at": datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "model_version": meta["model_version"], "process": "uvicorn, 1 worker, real bundle (same as Docker)",
        "ready_seconds": round(ready_s, 1), "rss_after_start_mb": round(after_start / 2**20, 1),
        "rss_peak_mb": round(peak[0] / 2**20, 1), "rss_after_workload_mb": round(after_load / 2**20, 1),
        "workload": f"303 patient bundles + {n} x (predict, validate, analyze/full, explain)",
    }
    perf_path = ROOT / "results" / "perf.json"
    perf = json.loads(perf_path.read_text(encoding="utf-8")) if perf_path.exists() else {}
    perf["memory"] = memory
    perf["bundle"] = bundle_sizes()
    perf_path.write_text(json.dumps(perf, indent=1) + "\n", encoding="utf-8")
    print(json.dumps({"memory": memory, "bundle": perf["bundle"]}, indent=1))


if __name__ == "__main__":
    main()
