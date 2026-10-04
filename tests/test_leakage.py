"""P0 leakage tests: labels and anything derived from labels can never be model inputs (plan §5.4)."""

from dataclasses import replace

import pytest

from novarion_ml.data.load import LeakageError, assert_no_leakage, build_X


def test_model_matrix_contains_no_label_columns(source, registry):
    X = build_X(source, registry)
    lowered = {c.lower() for c in X.columns}
    for label in registry.leakage_denylist:
        assert label not in X.columns and label.lower() not in lowered


@pytest.mark.parametrize("label", ["Cath", "CAD", "LAD", "LCX", "RCA"])
def test_direct_label_column_is_rejected(registry, label):
    with pytest.raises(LeakageError):
        assert_no_leakage([label], registry)


def test_feature_derived_from_a_label_is_rejected(registry):
    # Lineage check: a synthetic feature whose derived_from chain reaches a label must be rejected,
    # even though its own name is innocent.
    base = registry.features[0]
    sneaky = replace(base, id="derived_from_cad", source_column="sneaky", derived_from=("helper",))
    helper = replace(base, id="helper", source_column="helper_src", derived_from=("Cath",))
    patched = replace(registry, features=registry.features + (sneaky, helper))
    with pytest.raises(LeakageError, match="Cath"):
        assert_no_leakage(["derived_from_cad"], patched)


def test_engineered_features_do_not_touch_labels(registry):
    for eng in registry.engineered:
        assert not (registry.lineage(eng["id"]) & registry.leakage_denylist), eng["id"]
