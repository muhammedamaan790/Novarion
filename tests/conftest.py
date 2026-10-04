import json
from pathlib import Path

import pytest

from novarion_ml.data.load import load_source
from novarion_ml.data.registry import ROOT, default_registry

REPORT = ROOT / "data" / "schema_report.json"


def _require(path: Path) -> None:
    if not path.exists():
        pytest.skip(f"{path.name} missing — run scripts/download_data.py and scripts/profile_dataset.py")


@pytest.fixture(scope="session")
def source():
    _require(ROOT / "data" / "raw" / "z_alizadeh_sani_extension.xlsx")
    return load_source()


@pytest.fixture(scope="session")
def report():
    _require(REPORT)
    return json.loads(REPORT.read_text(encoding="utf-8"))


@pytest.fixture(scope="session")
def registry():
    return default_registry()
