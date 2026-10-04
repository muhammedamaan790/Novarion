"""Download the Extension of Z-Alizadeh Sani dataset (UCI #411, CC BY 4.0) and verify its checksum.

First run (no pin in config/data_source.json): downloads, records the SHA-256 pin and prints a notice.
Every later run: downloads (or reuses the cached file) and fails loudly if the checksum differs.
"""

from __future__ import annotations

import hashlib
import json
import sys
import urllib.request
import zipfile
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW_DIR = ROOT / "data" / "raw"
PIN_FILE = ROOT / "config" / "data_source.json"

SOURCE_URL = "https://archive.ics.uci.edu/static/public/411/extention+of+z+alizadeh+sani+dataset.zip"
ZIP_NAME = "uci_411.zip"
EXPECTED_MEMBER = "extention of Z-Alizadeh sani dataset.xlsx"
LOCAL_XLSX = "z_alizadeh_sani_extension.xlsx"


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 16), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    zip_path = RAW_DIR / ZIP_NAME
    if not zip_path.exists():
        print(f"Downloading {SOURCE_URL}")
        urllib.request.urlretrieve(SOURCE_URL, zip_path)

    with zipfile.ZipFile(zip_path) as archive:
        if EXPECTED_MEMBER not in archive.namelist():
            print(f"ERROR: expected member {EXPECTED_MEMBER!r} not in archive: {archive.namelist()}")
            return 1
        xlsx_path = RAW_DIR / LOCAL_XLSX
        xlsx_path.write_bytes(archive.read(EXPECTED_MEMBER))

    zip_sha = sha256_of(zip_path)
    xlsx_sha = sha256_of(xlsx_path)

    if PIN_FILE.exists():
        pin = json.loads(PIN_FILE.read_text(encoding="utf-8"))
        if pin["source_data_sha256"] != xlsx_sha:
            print("ERROR: checksum mismatch for the source data file.")
            print(f"  pinned:   {pin['source_data_sha256']}")
            print(f"  computed: {xlsx_sha}")
            return 1
        print(f"OK: source data verified (sha256 {xlsx_sha})")
        return 0

    pin = {
        "dataset": "Extension of Z-Alizadeh Sani dataset (UCI #411)",
        "license": "CC BY 4.0",
        "source_url": SOURCE_URL,
        "archive_member": EXPECTED_MEMBER,
        "archive_sha256": zip_sha,
        "source_data_sha256": xlsx_sha,
        "pinned_at": datetime.now(UTC).replace(microsecond=0).isoformat(),
    }
    PIN_FILE.write_text(json.dumps(pin, indent=2) + "\n", encoding="utf-8")
    print(f"PINNED (first run): source data sha256 {xlsx_sha} -> {PIN_FILE.relative_to(ROOT)}")
    print("Commit config/data_source.json so every later download is verified against this pin.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
