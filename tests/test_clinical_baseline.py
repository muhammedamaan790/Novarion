"""The guideline comparator is transcribed correctly (updated Diamond–Forrester, ESC 2013 / Genders 2011)."""

import importlib.util
import itertools

import pytest

from novarion_ml.data.registry import ROOT

spec = importlib.util.spec_from_file_location("clinical_evaluation", ROOT / "scripts" / "clinical_evaluation.py")
ce = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ce)


@pytest.mark.parametrize("age,male,pain,expected", [
    (35, 1, "typical", 0.59), (35, 0, "nonanginal", 0.05), (55, 1, "atypical", 0.49), (55, 0, "typical", 0.47),
    (65, 0, "atypical", 0.28), (75, 1, "nonanginal", 0.54), (85, 0, "typical", 0.76), (29, 1, "typical", 0.59),
])
def test_published_values(age, male, pain, expected):
    assert ce.df_probability(age, male, pain) == pytest.approx(expected)


def test_table_is_monotone_as_published():
    """Probability rises with age, is higher in men, and orders typical > atypical > non-anginal."""
    rows = list(ce.UPDATED_DF.values())
    for col in range(6):
        assert all(a[col] < b[col] for a, b in itertools.pairwise(rows))
    for r in rows:
        tm, tw, am, aw, nm, nw = r
        assert tm > tw and am > aw and nm > nw and tm > am > nm and tw > aw > nw


def test_metrics_helpers():
    import numpy as np

    y = np.array([0, 0, 1, 1])
    old, new = np.array([0.4, 0.6, 0.4, 0.6]), np.array([0.2, 0.3, 0.8, 0.9])
    nri, idi = ce.nri_idi(y, new, old)
    assert nri == pytest.approx(2.0) and idi == pytest.approx(0.6)
    assert ce.ece(np.array([0, 1]), np.array([0.0, 1.0]), bins=2) == 0
