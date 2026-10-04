"""P0 data-contract tests: schema, registry coverage, encodings, ranges, no UNKNOWN, label definitions."""

import pandas as pd
import pytest

from novarion_ml.data.load import build_targets, build_X, canonicalize, observed_decimals
from novarion_ml.data.registry import load_targets


def test_schema_matches_report(source, report):
    assert source.shape == (report["n_rows"], report["n_columns_total"]) == (303, 59)
    assert report["n_predictor_columns"] == 55
    assert report["label_columns"] == ["Cath", "LAD", "LCX", "RCA"]
    assert report["separate_cad_column_present"] is False
    assert report["any_missing_values"] is False


def test_registry_covers_every_predictor_exactly_once(source, registry, report):
    label_cols = set(report["label_columns"])
    predictors = [c for c in source.columns if c not in label_cols]
    mapped = [f.source_column for f in registry.features]
    assert sorted(mapped) == sorted(predictors), "registry must map each source predictor exactly once"
    assert not (set(mapped) & registry.leakage_denylist)


def test_every_model_feature_is_required(registry):
    # Registry lint (contract-freeze test): a model feature can never be optional.
    assert all(f.required_for_prediction for f in registry.features)


def test_source_tokens_and_categories_cover_observed_values(source, registry):
    for f in registry.features:
        if f.kind == "continuous":
            continue
        observed = set(source[f.source_column].unique())
        known = set(f.source_tokens) | {str(k) for k in f.source_tokens}
        assert observed <= known, f"{f.id}: unseen tokens {observed - known}"
        if f.kind in {"ordinal", "nominal"}:
            assert set(map(str, f.source_tokens.values())) <= set(f.categories), f"{f.id}: categories incomplete"


def test_hard_ranges_contain_all_training_values_and_precision_is_sufficient(source, registry):
    for f in registry.features:
        if f.kind != "continuous":
            continue
        col = source[f.source_column]
        lo, hi = f.hard_valid_range
        assert lo <= col.min() and col.max() <= hi, f"{f.id}: training values outside hard_valid_range"
        if f.input_mode != "computed":  # computed features (bmi) are re-derived, not stored at source precision
            assert observed_decimals(col) <= f.canonical_precision, f"{f.id}: canonical_precision too coarse"


def test_canonical_encodings(source, registry):
    frame = canonicalize(source, registry)
    sex = dict(zip(source["Sex"], frame["sex"], strict=True))
    assert sex["Male"] == 1 and sex["Fmale"] == 0  # source typo 'Fmale' handled
    assert set(frame["obesity"].unique()) <= {0, 1}  # Y/N binary
    assert set(frame["diabetes"].unique()) <= {0, 1}  # 0/1 binary
    assert set(frame["function_class"]) <= {"0", "1", "2", "3"}
    assert set(frame["valvular_heart_disease"]) <= {"none", "mild", "moderate", "severe"}
    assert set(frame["bundle_branch_block"]) <= {"none", "lbbb", "rbbb"}
    assert frame.index.name == "dataset_record_id"


def test_training_data_has_no_unknown_and_no_missing(source, registry):
    X = build_X(source, registry)
    assert not (X.astype(str) == registry.unknown_token).any().any()
    assert not X.isna().any().any()
    assert X.shape == (303, 55)


def test_targets_and_prevalence_match_report(source, report):
    y = build_targets(source)
    assert set(y) == {"cad", "lad", "lcx", "rca"}
    source_col = {t["id"]: t["source_column"] for t in load_targets()["targets"]}
    for tid, series in y.items():
        assert int(series.sum()) == report["prevalence"][source_col[tid]]["n_positive"]


def test_label_relationship_is_documented(source, report):
    # D-001: Cath agrees with any-vessel-stenotic for 302/303; row 93 is the documented exception.
    y = build_targets(source)
    any_vessel = ((y["lad"] + y["lcx"] + y["rca"]) > 0).astype(int)
    discordant = list(y["cad"].index[y["cad"] != any_vessel])
    assert discordant == [93]
    assert report["label_relationship"]["disagreement"] == 1


def test_cv_feasibility_gate(source):
    # P0 gate (plan §6.1): n_pos >= 5*k and n_neg >= 5*k for k = 5 outer folds, for every target.
    for tid, series in build_targets(source).items():
        assert series.sum() >= 25 and (len(series) - series.sum()) >= 25, f"{tid} fails CV feasibility"


def test_computed_features_match_their_formulas(source):
    bmi = source["Weight"] / (source["Length"] / 100) ** 2
    assert (source["BMI"] - bmi).abs().max() < 1e-9  # D-002
    agree = ((source["Obesity"] == "Y") == (source["BMI"] > 25)).sum()
    assert agree == 302  # documented boundary exception (row 153, BMI = 25.0)


@pytest.mark.parametrize("bad", [pd.Series(["Male", "Unknown"])])
def test_unseen_category_is_rejected(registry, bad):
    from novarion_ml.data.load import _canonical_column

    sex = registry.by_id()["sex"]
    with pytest.raises(ValueError, match="unseen source token"):
        _canonical_column(sex, bad)
