"""Clinical-standard evaluation (D-021) → results/clinical_evaluation.json.

Motivated by the reporting gaps an umbrella review of AI for cardiovascular risk prediction identifies (Parizad et
al., Vasc Health Risk Manag 2026; comparison with traditional scores, calibration beyond AUC, subgroup / fairness
analysis, clinical utility). Everything uses the frozen v1.0 out-of-fold predictions of the prespecified evaluation
repeat (each patient scored once, by a model that never saw them); no model is changed.

1. Clinical baseline for CAD: the updated Diamond–Forrester pretest probability (age decade × sex × chest-pain type;
   ESC 2013 stable CAD guideline, from Genders et al. 2011, ≥50% stenosis) — applied as published, and a logistic
   regression on the same three inputs refit inside the same outer folds ("what do the other 52 features add?").
   Paired bootstrap ΔAUC, continuous NRI and IDI, Brier, calibration, and the ESC 15% / 85% pretest bands.
2. Subgroups (sex; age < 50, 50–64, ≥ 65) for all four targets, with n and suppression below 10 per class.
3. Calibration-in-the-large, expected calibration error (10 equal-frequency bins) and decision-curve net benefit.
Usage: uv run --group train python scripts/clinical_evaluation.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "ml"))

from novarion_ml.calibrate.platt import calibration_slope_intercept
from novarion_ml.data.load import build_targets, build_X, load_source, patient_id
from novarion_ml.train.config import default_train_config

TARGETS = ("cad", "lad", "lcx", "rca")
SEED = 20261013
B = 2000

# Updated Diamond–Forrester pretest probability of ≥50% CAD (%), ESC 2013 stable CAD guideline (Montalescot et al.,
# Eur Heart J 2013;34:2949), derived from Genders et al., Eur Heart J 2011;32:1316. Rows: age band; values:
# (typical men, typical women, atypical men, atypical women, non-anginal men, non-anginal women).
UPDATED_DF = {
    (30, 39): (59, 28, 29, 10, 18, 5),
    (40, 49): (69, 37, 38, 14, 25, 8),
    (50, 59): (77, 47, 49, 20, 34, 12),
    (60, 69): (84, 58, 59, 28, 44, 17),
    (70, 79): (89, 68, 69, 37, 54, 24),
    (80, 200): (93, 76, 78, 47, 65, 32),
}


def df_probability(age: float, male: int, pain: str) -> float:
    for (lo, hi), row in UPDATED_DF.items():
        if lo <= age <= hi or (age < 30 and lo == 30):
            offset = {"typical": 0, "atypical": 2, "nonanginal": 4}[pain]
            return row[offset + (0 if male else 1)] / 100
    raise ValueError(f"no age band for {age}")


def pain_type(row) -> str | None:
    if row["typical_chest_pain"] == 1:
        return "typical"
    if row["atypical_chest_pain"] == 1:
        return "atypical"
    if row["nonanginal_chest_pain"] == 1:
        return "nonanginal"
    return None


def logit(p: np.ndarray) -> np.ndarray:
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return np.log(p / (1 - p))


def brier(y, p) -> float:
    return float(np.mean((p - y) ** 2))


def ece(y, p, bins: int = 10) -> float:
    order = np.argsort(p)
    total = 0.0
    for chunk in np.array_split(order, bins):
        if len(chunk):
            total += len(chunk) * abs(y[chunk].mean() - p[chunk].mean())
    return float(total / len(y))


def calibration(y, p) -> dict:
    slope, _ = calibration_slope_intercept(logit(p), y)
    return {"brier": brier(y, p), "calibration_in_the_large": float(y.mean() - p.mean()), "ece": ece(y, p),
            "calibration_slope": slope}


def nri_idi(y, p_new, p_old) -> tuple[float, float]:
    """Continuous (category-free) NRI and IDI of p_new over p_old."""
    up, down = p_new > p_old, p_new < p_old
    ev, ne = y == 1, y == 0
    nri = (up[ev].mean() - down[ev].mean()) + (down[ne].mean() - up[ne].mean())
    idi = (p_new[ev].mean() - p_new[ne].mean()) - (p_old[ev].mean() - p_old[ne].mean())
    return float(nri), float(idi)


def ci(values: list[float]) -> list[float]:
    return [float(np.percentile(values, 2.5)), float(np.percentile(values, 97.5))]


def compare(y, p_new, p_old, rng) -> dict:
    base = {"auc_new": float(roc_auc_score(y, p_new)), "auc_old": float(roc_auc_score(y, p_old))}
    nri, idi = nri_idi(y, p_new, p_old)
    d_auc, nris, idis = [], [], []
    for _ in range(B):
        i = rng.integers(0, len(y), len(y))
        if y[i].min() == y[i].max():
            continue
        d_auc.append(roc_auc_score(y[i], p_new[i]) - roc_auc_score(y[i], p_old[i]))
        n, d = nri_idi(y[i], p_new[i], p_old[i])
        nris.append(n)
        idis.append(d)
    return {**base, "delta_auc": base["auc_new"] - base["auc_old"], "delta_auc_ci95": ci(d_auc),
            "nri": nri, "nri_ci95": ci(nris), "idi": idi, "idi_ci95": ci(idis)}


def bands(y, p) -> dict:
    out = {}
    for name, mask in (("low (<15%)", p < 0.15), ("intermediate (15-85%)", (p >= 0.15) & (p <= 0.85)),
                       ("high (>85%)", p > 0.85)):
        out[name] = {"n": int(mask.sum()), "share": float(mask.mean()),
                     "observed_cad_rate": float(y[mask].mean()) if mask.any() else None}
    return out


def net_benefit(y, p, thresholds) -> list[float]:
    n = len(y)
    out = []
    for t in thresholds:
        pos = p >= t
        tp, fp = int((pos & (y == 1)).sum()), int((pos & (y == 0)).sum())
        out.append(tp / n - fp / n * t / (1 - t))
    return out


def main() -> None:
    train = default_train_config()
    source = load_source()
    X, Y = build_X(source), build_targets(source)
    rng = np.random.default_rng(SEED)
    oof: dict[str, dict] = {t: {} for t in TARGETS}
    fold_of: dict[int, int] = {}
    records = {}
    for t in TARGETS:
        for k in range(train.outer_k):
            rec = json.loads((ROOT / "results" / "nested" / t / f"r{train.evaluation_repeat}f{k}.json").read_text())
            records[(t, k)] = rec
            for rid, p, pred in zip(rec["test_ids"], rec["test"]["prob"], rec["test"]["pred"], strict=True):
                oof[t][int(rid)] = (p, pred)
                if t == "cad":
                    fold_of[int(rid)] = k
    ids = np.array(sorted(oof["cad"]))
    out: dict = {"scope": "pooled OOF, prespecified evaluation repeat (each patient once)", "bootstrap": B,
                 "reference": "Parizad et al., Vasc Health Risk Manag 2026 (umbrella review): reporting gaps"}

    # ---- 1. clinical baseline (CAD)
    y = Y["cad"].loc[ids].to_numpy()
    p_model = np.array([oof["cad"][i][0] for i in ids])
    pains = [pain_type(X.loc[i]) for i in ids]
    covered = np.array([pt is not None for pt in pains])
    p_df = np.array([df_probability(X.loc[i, "age"], int(X.loc[i, "sex"]), pt) if pt else np.nan
                     for i, pt in zip(ids, pains, strict=True)])
    # the same three inputs refit within each outer fold (one-hot pain type incl. "none"), unpenalized-ish LR
    feats = np.column_stack([X.loc[ids, "age"].to_numpy(), X.loc[ids, "sex"].to_numpy(),
                             [pt == "typical" for pt in pains], [pt == "atypical" for pt in pains],
                             [pt == "nonanginal" for pt in pains]]).astype(float)
    p_refit = np.empty(len(ids))
    for k in range(train.outer_k):
        rec = records[("cad", k)]
        tr = np.isin(ids, rec["train_ids"])
        te = np.isin(ids, rec["test_ids"])
        lr = LogisticRegression(C=1e4, max_iter=5000).fit(feats[tr], y[tr])
        p_refit[te] = lr.predict_proba(feats[te])[:, 1]
    c = covered
    out["clinical_baseline"] = {
        "population": f"{int(c.sum())} of {len(ids)} patients with a chest-pain type (Diamond-Forrester's domain); "
                      f"{int((~c).sum())} without chest pain are outside the published table",
        "n": int(c.sum()), "cad_prevalence": float(y[c].mean()),
        "novarion_vs_published_df": compare(y[c], p_model[c], p_df[c], rng),
        "novarion_vs_df_inputs_refit": compare(y[c], p_model[c], p_refit[c], rng),
        "calibration": {"novarion": calibration(y[c], p_model[c]), "published_df": calibration(y[c], p_df[c]),
                        "df_inputs_refit": calibration(y[c], p_refit[c])},
        "esc_pretest_bands": {"novarion": bands(y[c], p_model[c]), "published_df": bands(y[c], p_df[c])},
    }

    # ---- 2. subgroups (all targets) and 3. calibration overall
    groups = {"all": np.ones(len(ids), bool), "female": X.loc[ids, "sex"].to_numpy() == 0,
              "male": X.loc[ids, "sex"].to_numpy() == 1, "age < 50": X.loc[ids, "age"].to_numpy() < 50,
              "age 50-64": (X.loc[ids, "age"].to_numpy() >= 50) & (X.loc[ids, "age"].to_numpy() < 65),
              "age >= 65": X.loc[ids, "age"].to_numpy() >= 65}
    sub: dict = {}
    for t in TARGETS:
        yt = Y[t].loc[ids].to_numpy()
        pt = np.array([oof[t][i][0] for i in ids])
        pred = np.array([oof[t][i][1] for i in ids])
        sub[t] = {}
        for g, m in groups.items():
            n_pos, n_neg = int(yt[m].sum()), int((1 - yt[m]).sum())
            row = {"n": int(m.sum()), "n_positive": n_pos, "prevalence": float(yt[m].mean())}
            if n_pos >= 10 and n_neg >= 10:
                aucs = []
                for _ in range(B):
                    i = rng.integers(0, int(m.sum()), int(m.sum()))
                    yy, pp = yt[m][i], pt[m][i]
                    if 0 < yy.sum() < len(yy):
                        aucs.append(roc_auc_score(yy, pp))
                row.update(auc=float(roc_auc_score(yt[m], pt[m])), auc_ci95=ci(aucs),
                           sensitivity=float(pred[m][yt[m] == 1].mean()),
                           specificity=float(1 - pred[m][yt[m] == 0].mean()), **calibration(yt[m], pt[m]))
            else:
                row["status"] = "insufficient evidence (< 10 per class)"
            sub[t][g] = row
    out["subgroups"] = sub

    # ---- 3b. decision curves (research metric: net benefit, no clinical recommendation)
    thresholds = [round(x, 2) for x in np.arange(0.05, 0.96, 0.05)]
    dca = {"thresholds": thresholds}
    for t in TARGETS:
        yt = Y[t].loc[ids].to_numpy()
        pt = np.array([oof[t][i][0] for i in ids])
        dca[t] = {"model": net_benefit(yt, pt, thresholds), "treat_all": net_benefit(yt, np.ones(len(yt)), thresholds)}
    dca["cad_published_df"] = net_benefit(y[c], p_df[c], thresholds)
    dca["cad_model_same_patients"] = net_benefit(y[c], p_model[c], thresholds)
    dca["cad_treat_all_same_patients"] = net_benefit(y[c], np.ones(int(c.sum())), thresholds)
    out["decision_curves"] = dca
    out["patients_without_chest_pain"] = [patient_id(int(i)) for i in ids[~c]]
    (ROOT / "results" / "clinical_evaluation.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
    # The Model Evidence page's static copy is published bound to the model it describes (audit R09).
    sys.path.insert(0, str(ROOT / "scripts"))
    from publish_evidence import publish

    publish()

    cb = out["clinical_baseline"]
    for name in ("novarion_vs_published_df", "novarion_vs_df_inputs_refit"):
        r = cb[name]
        print(f"{name}: AUC {r['auc_new']:.3f} vs {r['auc_old']:.3f}; dAUC {r['delta_auc']:+.3f} "
              f"{[round(v, 3) for v in r['delta_auc_ci95']]}; NRI {r['nri']:+.2f} {[round(v, 2) for v in r['nri_ci95']]}; "
              f"IDI {r['idi']:+.3f} {[round(v, 3) for v in r['idi_ci95']]}")
    for name, cal in cb["calibration"].items():
        print(f"  calibration {name}: CITL {cal['calibration_in_the_large']:+.3f}, ECE {cal['ece']:.3f}, "
              f"slope {cal['calibration_slope']}, Brier {cal['brier']:.3f}")
    for name, b in cb["esc_pretest_bands"].items():
        print(f"  bands {name}: " + "; ".join(f"{k} {v['share']:.0%} (CAD {v['observed_cad_rate']})" for k, v in b.items()))
    for t in TARGETS:
        print(t, {g: (round(r["auc"], 3) if "auc" in r else r["status"][:12]) for g, r in sub[t].items()})


if __name__ == "__main__":
    main()
