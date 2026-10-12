"""Release secret scan (plan §11A "Secret scan"): tracked files + the frontend build, if built.

Fails on committed .env files, private keys, common API-key/token formats, credentials in URLs, assignments of
secret-looking literals, and private/internal URLs or debug endpoints in the shipped frontend build.
Usage: uv run python scripts/secret_scan.py   (exit 1 with a list of findings; CI runs it)
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BINARY = {".png", ".jpg", ".glb", ".pdf", ".ico", ".woff", ".woff2", ".joblib", ".xlsx", ".zip", ".gz"}
SKIP = {"uv.lock", "frontend/package-lock.json", "scripts/secret_scan.py"}

PATTERNS = {
    "private key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----"),
    "GitHub token": re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{40,}"),
    "AWS access key": re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    "Slack token": re.compile(r"\bxox[abpors]-[A-Za-z0-9-]{10,}"),
    "API key (sk-)": re.compile(r"\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}"),
    "Google API key": re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b"),
    "credentials in URL": re.compile(r"\b[a-z][a-z0-9+.-]*://[^\s/:@'\"]+:[^\s/@'\"]{3,}@[^\s'\"]+", re.IGNORECASE),
    "secret assignment": re.compile(
        r"(?i)\b(?:api[_-]?key|secret|password|passwd|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*['\"][^'\"\s]{12,}['\"]"),
}
BUILD_ONLY = {  # shipped JavaScript must not point at private hosts or debug routes
    "private URL": re.compile(r"https?://(?:10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)[:/]"),
    "debug endpoint": re.compile(r"/(?:__debug__|debug/pprof|_debug)\b"),
}


def tracked() -> list[Path]:
    out = subprocess.run(["git", "ls-files", "-z"], cwd=ROOT, capture_output=True, check=True).stdout.decode()
    return [ROOT / p for p in out.split("\0") if p and p not in SKIP]


def scan(path: Path, patterns: dict[str, re.Pattern]) -> list[str]:
    if path.suffix.lower() in BINARY or not path.is_file():
        return []
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return []
    rel = path.relative_to(ROOT).as_posix()
    hits = []
    for name, pattern in patterns.items():
        for m in pattern.finditer(text):
            line = text.count("\n", 0, m.start()) + 1
            hits.append(f"{rel}:{line}: {name}")
    return hits


def main() -> int:
    findings = []
    files = tracked()
    for path in files:
        name = path.name
        if name == ".env" or (name.startswith(".env.") and name != ".env.example"):
            findings.append(f"{path.relative_to(ROOT).as_posix()}: committed environment file")
        findings += scan(path, PATTERNS)
    dist = ROOT / "frontend" / "dist"
    built = [p for p in dist.rglob("*") if p.is_file()] if dist.exists() else []
    for path in built:
        findings += scan(path, {**PATTERNS, **BUILD_ONLY})
    for f in findings:
        print(f)
    print(f"secret scan: {len(files)} tracked files, {len(built)} build files, {len(findings)} finding(s)")
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
