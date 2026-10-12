"""The release secret scan finds what it claims to find (samples are assembled at runtime, never committed)."""

import importlib.util

from novarion_ml.data.registry import ROOT

spec = importlib.util.spec_from_file_location("secret_scan", ROOT / "scripts" / "secret_scan.py")
scan_mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scan_mod)


def test_scanner_detects_planted_secrets(tmp_path, monkeypatch):
    monkeypatch.setattr(scan_mod, "ROOT", tmp_path)
    samples = {
        "private key": "-----BEGIN " + "RSA PRIVATE KEY-----",
        "GitHub token": "gh" + "p_" + "a" * 36,
        "AWS access key": "AK" + "IA" + "ABCDEFGHIJKLMNOP",
        "credentials in URL": "postgres://admin:" + "hunter22" + "@db.example.com/x",
        "secret assignment": "api_key = '" + "x" * 20 + "'",
    }
    for name, text in samples.items():
        path = tmp_path / f"{name.replace(' ', '_')}.txt"
        path.write_text(f"line one\n{text}\n", encoding="utf-8")
        hits = scan_mod.scan(path, scan_mod.PATTERNS)
        assert hits and hits[0].endswith(f":2: {name}"), (name, hits)
    clean = tmp_path / "clean.py"
    clean.write_text("password = os.environ['DB_PASSWORD']\nurl = 'https://example.com/a'\n", encoding="utf-8")
    assert scan_mod.scan(clean, scan_mod.PATTERNS) == []


def test_repository_is_clean():
    assert scan_mod.main() == 0
