"""ML core (plan §5.2, §6.1–6.5, §6.11, §7, §8): unit tests that need no trained bundle."""

import warnings

import numpy as np
import pandas as pd
import pytest

pytest.importorskip("sklearn")
pytest.importorskip("xgboost")

from novarion_ml.calibrate.platt import Platt, calibration_slope_intercept, fit_platt, sigmoid
from novarion_ml.data.load import build_targets, build_X
from novarion_ml.evaluate.metrics import classification, summarize
from novarion_ml.features.encoder import RegistryEncoder, feature_set_ids
from novarion_ml.thresholds.layers import select_thresholds, wilson_lower, youden_threshold
from novarion_ml.train.config import default_train_config
from novarion_ml.train.models import CandidateModel, balanced_weights
from novarion_ml.train.nested import CalibrationFailure, InnerResult, select
from novarion_ml.train.splits import FeasibilityError, check_feasible, stratified
from novarion_ml.uncertainty.reference import Ledger, ReferenceContext

warnings.filterwarnings("ignore")
TRAIN = default_train_config()


@pytest.fixture(scope="module")
def data(source):
    return build_X(source), build_targets(source)


# --------------------------------------------------------------------------------------------- grid
def test_grid_is_the_preregistered_92_configurations_in_simplicity_order():
    configs = TRAIN.configs
    assert len(configs) == 92 and len({c.config_id for c in configs}) == 92
    assert [c.complexity_rank for c in configs] == list(range(92))
    families = [c.family for c in configs]
    assert families == sorted(families, key=["lr", "ebm", "xgboost", "catboost"].index)
    first = configs[0]
    assert (first.family, first.params, first.feature_set, first.class_weight) == (
        "lr", {"penalty": "elasticnet", "C": 0.01}, "redundancy_reduced", "none")
    assert configs[1].class_weight == "balanced" and configs[2].feature_set == "full"


def test_balanced_weights_formula():
    y = np.array([1, 1, 1, 0])
    w = balanced_weights(y)
    assert w[0] == pytest.approx(4 / 6) and w[3] == pytest.approx(4 / 2)


# --------------------------------------------------------------------------------------------- features
def test_encoder_is_fold_local_and_keeps_feature_identity(data):
    X, _ = data
    enc = RegistryEncoder(feature_set_ids("full"), linear=True).fit(X.iloc[:100])
    assert "exertional_chest_pain" in enc.dropped_  # zero variance inside this partition
    assert enc.origins_.count("bundle_branch_block") == 3 and enc.origins_.count("region_rwma") == 5
    raw = enc._raw(X.iloc[:100])
    np.testing.assert_allclose(enc.mean_, raw.mean(axis=0))  # scaling fit on the partition only
    assert set(feature_set_ids("full")) - set(feature_set_ids("redundancy_reduced")) == {"weight", "height", "obesity"}


@pytest.mark.parametrize("family", ["lr", "xgboost", "catboost", "ebm"])
def test_explanations_are_exactly_additive_in_the_raw_margin(data, family):
    """Library-semantics golden test (plan §8): base + Σ contributions == the model's raw margin."""
    X, Y = data
    config = next(c for c in TRAIN.configs if c.family == family)
    model = CandidateModel(config, TRAIN, seed=1).fit(X.iloc[:200], Y["lad"].to_numpy()[:200])
    model.fit_background(X.iloc[:200])
    base, contrib = model.raw_contributions(X.iloc[200:230])
    np.testing.assert_allclose(base + contrib.sum(axis=1), model.margin(X.iloc[200:230]), rtol=1e-6, atol=1e-5)
    assert contrib.shape[1] == len(model.origins)


# --------------------------------------------------------------------------------------------- calibration
def test_platt_recovers_a_known_recalibration():
    rng = np.random.default_rng(0)
    z = rng.normal(0, 2, 20000)
    y = (rng.random(20000) < sigmoid(0.6 * z - 0.3)).astype(int)
    platt = fit_platt(z, y)
    assert platt.a == pytest.approx(0.6, abs=0.05) and platt.b == pytest.approx(-0.3, abs=0.05) and platt.valid


def test_calibration_slope_is_na_for_a_single_class():
    assert calibration_slope_intercept(np.array([0.1, 0.4]), np.array([1, 1])) == (None, None)


def _inner(rank: int, aucs: list[float], margin: np.ndarray) -> InnerResult:
    return InnerResult(TRAIN.configs[rank], aucs, [0.2] * len(aucs), margin)


def test_one_se_rule_picks_the_simplest_eligible_and_the_guard_skips_reversed_calibration():
    rng = np.random.default_rng(1)
    y = rng.integers(0, 2, 200)
    good = y + rng.normal(0, 1, 200)
    results = [
        _inner(50, [0.80, 0.82, 0.78, 0.81, 0.79], good),       # best AUC
        _inner(30, [0.80, 0.80, 0.79, 0.80, 0.79], good),       # mean 0.796 ≥ 0.80 − SE (0.0071): eligible, simpler
        _inner(5, [0.60, 0.61, 0.59, 0.60, 0.62], good),        # not eligible
    ]
    assert select(results, y).config.complexity_rank == 30
    results[1] = _inner(30, [0.80, 0.80, 0.79, 0.80, 0.79], -good)  # simplest eligible has a <= 0
    chosen = select(results, y)
    assert chosen.config.complexity_rank == 50 and chosen.guard_log
    with pytest.raises(CalibrationFailure):
        select([_inner(30, [0.8] * 5, -good)], y)


# --------------------------------------------------------------------------------------------- thresholds
def test_wilson_lower_bound_known_value():
    assert wilson_lower(45, 50) == pytest.approx(0.7864, abs=1e-4)


def test_youden_maximum_and_tie_rule():
    assert youden_threshold(np.array([0.1, 0.2, 0.8, 0.9]), np.array([0, 0, 1, 1])) == pytest.approx(0.8)
    # t = 0.3 and t = 0.8 both give J = 0.5; the one closest to 0.5 wins
    assert youden_threshold(np.array([0.2, 0.3, 0.7, 0.8]), np.array([0, 1, 0, 1])) == pytest.approx(0.3)


def test_regions_exist_only_when_the_wilson_bound_qualifies():
    rng = np.random.default_rng(3)
    # ≥ 73 clean cases are needed: Wilson LB(n/n) = n/(n + 3.84) reaches 0.95 only at n ≥ 73
    p = np.concatenate([rng.uniform(0, 0.15, 100), rng.uniform(0.3, 0.7, 80), rng.uniform(0.85, 1, 100)])
    y = np.concatenate([np.zeros(100), rng.integers(0, 2, 80), np.ones(100)]).astype(int)
    thr = select_thresholds(p, y, target_ppv=0.90, target_npv=0.95, n_min=15)
    assert thr.t_neg is not None and thr.t_pos is not None and thr.t_neg <= thr.t_op <= thr.t_pos
    assert thr.q_pos.lower_bound >= 0.90 and thr.q_neg.lower_bound >= 0.95
    noisy = select_thresholds(rng.random(200), rng.integers(0, 2, 200), 0.90, 0.95, 15)
    assert noisy.t_neg is None and noisy.t_pos is None  # no clamping: regions simply do not exist
    assert noisy.region(0.99) == "low_confidence"


# --------------------------------------------------------------------------------------------- splits / metrics
def test_feasibility_gate_stops_instead_of_reducing_k():
    y = np.array([1] * 8 + [0] * 92)
    with pytest.raises(FeasibilityError):
        check_feasible(y, stratified(y, 5, 0), 3, "test")


def test_undefined_metrics_are_na_not_zero():
    m = classification(np.array([1, 0, 1]), np.array([0, 0, 0]))
    assert m["precision"] is None and m["recall"] == 0
    s = summarize([{"precision": None}, {"precision": 0.5}, {"precision": 0.7}], ["precision"])
    assert s["precision"]["n_na"] == 1 and s["precision"]["mean"] == pytest.approx(0.6)


# --------------------------------------------------------------------------------------------- reference context
def test_reference_context_gower_unknown_ledger_and_comparisons(data):
    X, Y = data
    labels = pd.DataFrame(Y)
    ref_ids = X.index[:200]
    ledger = Ledger(np.linspace(0, 1, 200), Y["lad"].loc[ref_ids].to_numpy())
    ref = ReferenceContext(X.loc[ref_ids], labels, {"lad": ledger}, "test", n_min_compare=20,
                           evidence_bands=[[0, .2], [.2, .4], [.4, .6], [.6, .8], [.8, 1.0]], band_min_n=20)
    q = {k: (v.item() if hasattr(v, "item") else v) for k, v in X.loc[250].items()}
    nn = ref.neighbours(q)
    assert len(nn) == 10 and all(rid in set(ref_ids) for rid, _ in nn)
    assert [d for _, d in nn] == sorted(d for _, d in nn)
    first = int(ref_ids[0])
    self_q = {k: (v.item() if hasattr(v, "item") else v) for k, v in X.loc[first].items()}
    assert ref.neighbours(self_q)[0] == (first, 0.0)
    assert first not in [rid for rid, _ in ref.neighbours(self_q, exclude_id=first)]
    unknown_q = {**q, "ldl": "__UNKNOWN__"}
    assert "ldl" in ref.atypical(unknown_q)["excluded_unknown_features"]
    assert ref.impute(unknown_q)["ldl"] == ref.imputation["ldl"]
    assert ref.ledger("lad", 1.0)["band"] == [0.8, 1.0]
    cmp = ref.comparison("lad", "typical_chest_pain", 1)
    assert cmp["type"] == "binary_prevalence" and cmp["negative"]["status"] == "ok"
    assert Platt(0.0, 0.0).valid is False


# --------------------------------------------------------------------------------------------- stability (§6.10a)
def test_stability_bootstrap_is_oof_safe_and_needs_enough_valid_replicates(data):
    from novarion_ml.uncertainty.stability import stability_fold

    X, Y = data
    config = next(c for c in TRAIN.configs if c.config_id.startswith("lr[penalty=l2,C=1]"))
    ids = np.array(sorted(int(i) for i in X.index))
    train_ids, test_ids = ids[:240], ids[240:]
    out = stability_fold("cad", 0, train_ids, test_ids, config, X, Y["cad"], TRAIN, replicates=4, min_valid=3)
    assert set(out["intervals"]) == {int(i) for i in test_ids}  # every held-out patient, nothing else
    assert out["n_valid"] >= 3
    for interval in out["intervals"].values():
        assert 0 <= interval["p10"] <= interval["p90"] <= 1 and interval["n_valid"] == out["n_valid"]
    strict = stability_fold("cad", 0, train_ids, test_ids[:3], config, X, Y["cad"], TRAIN, replicates=2, min_valid=80)
    assert all("p10" not in v for v in strict["intervals"].values())  # < min_valid → no interval is shown
    with pytest.raises(AssertionError, match="held-out"):
        stability_fold("cad", 0, ids[:250], ids[240:], config, X, Y["cad"], TRAIN, replicates=1)
