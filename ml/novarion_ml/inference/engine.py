"""Inference engine: canonical inputs → predictions, explanations, evidence, quality (plan §6.5, §6.11, §8, §11).

One code path for both modes, so a displayed probability is always explained by the model that produced it:
  - OOF mode (dataset patients): per target, fold k's model + Platt + thresholds + ReferenceContext_k
  - final_model mode (new / edited cases): the deployed model per target + the full-cohort ReferenceContext
Outputs are plain dicts shaped exactly like the API schemas (the backend validates them with Pydantic).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

import numpy as np
import pandas as pd

from ..calibrate.platt import Platt, sigmoid
from ..data.load import patient_id
from ..data.registry import Feature, Registry, default_registry
from ..thresholds.layers import Thresholds
from ..train.models import CandidateModel
from ..uncertainty.reference import ReferenceContext

REASON_ORDER = ("unknown_input", "atypical_profile", "unstable", "no_qualified_region", "gray_zone")


@dataclass
class TargetArtifact:
    target: str
    label: str
    anatomy_key: str
    model: CandidateModel
    platt: Platt
    thresholds: Thresholds
    reference: ReferenceContext
    strength: dict[str, float]  # {"q1", "q2"}: tertiles of |contribution| over the target's OOF population
    evaluation: dict[str, Any]  # cohort-level Table 2 row (pooled OOF, prespecified repeat)


def display_value(feature: Feature, value: Any) -> str:
    if feature.kind == "binary":
        return feature.categories[int(value)].capitalize() if feature.categories else ("Yes" if value == 1 else "No")
    if feature.kind == "continuous":
        unit = feature.canonical_unit or ""
        return f"{float(value):.{feature.display_precision or 0}f}{'' if unit == '%' else ' '}{unit}".strip()
    return str(value).capitalize()


def strength(magnitude: float, q: dict[str, float]) -> str:
    return "slight" if magnitude <= q["q1"] else "moderate" if magnitude <= q["q2"] else "strong"


class Engine:
    def __init__(self, targets: dict[str, TargetArtifact], mode: str, registry: Registry | None = None):
        self.targets = targets
        self.mode = mode
        self.registry = registry or default_registry()
        self.by_id = self.registry.by_id()
        self.unknown = self.registry.unknown_token

    # -------------------------------------------------------------------------------------------- building blocks
    def _frame(self, imputed: dict[str, Any]) -> pd.DataFrame:
        return pd.DataFrame([{f.id: imputed[f.id] for f in self.registry.features}])

    def quality(self, canonical: dict[str, Any]) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
        """Atypical check per target reference; a flag against ANY target's reference forces LOW everywhere (D-010)."""
        per_target = {t: art.reference.atypical(canonical) for t, art in self.targets.items()}
        flag = any(a["flag"] for a in per_target.values())
        outside = sorted({f for a in per_target.values() for f in a["outside_observed_range"]})
        quality = {
            "atypical_profile": {"flag": flag,
                                 "distance_percentile": max(a["distance_percentile"] for a in per_target.values())},
            "out_of_range_features": outside,
            "unknown_inputs": sorted(k for k, v in canonical.items() if v == self.unknown),
            "class_conflict_note": None,
            "notices": [],
        }
        return quality, per_target

    def _prediction(self, art: TargetArtifact, cal_logit: float, quality: dict[str, Any]) -> dict[str, Any]:
        thr = art.thresholds
        p = float(sigmoid(np.array([cal_logit]))[0])
        region = thr.region(p)
        reasons = []
        if quality["unknown_inputs"]:
            reasons.append("unknown_input")
        if quality["atypical_profile"]["flag"]:
            reasons.append("atypical_profile")
        if region == "low_confidence":
            side_missing = thr.t_pos is None if p >= thr.t_op else thr.t_neg is None
            reasons.append("no_qualified_region" if side_missing else "gray_zone")
        reasons = sorted(set(reasons), key=REASON_ORDER.index)
        qualification = evaluation = None
        if not reasons:
            q = thr.q_pos if region == "high_positive" else thr.q_neg
            metric = q.metric
            qualification = {"metric": metric, "target": q.target, "lower_bound": q.lower_bound, "n": q.n,
                             "source": "training_side_oof"}
            ev = art.evaluation
            n = ev["n_high_positive"] if metric == "ppv" else ev["n_high_negative"]
            value = ev[metric]
            if value is None or n == 0:  # never quote a PPV/NPV we did not measure; surface it instead
                raise ValueError(f"{art.target}: {region} region has no outer-validation evidence (Table 2 n = 0)")
            evaluation = {"metric": metric, "value": value, "ci": ev.get(f"{metric}_ci"), "n": n,
                          "level": "cohort", "source": "prespecified_outer_repeat"}
        return {
            "label": art.label, "anatomy_key": art.anatomy_key,
            "predicted_class": "positive" if p >= thr.t_op else "negative",
            "probability": p, "calibrated_logit": cal_logit, "operating_threshold": thr.t_op,
            "model_confidence": "high" if not reasons else "low",
            "model_confidence_thresholds": {"negative_below": thr.t_neg, "positive_at_or_above": thr.t_pos},
            "model_confidence_region": region, "model_confidence_reasons": reasons,
            "confidence_qualification": qualification, "evaluation_context": evaluation, "stability_interval": None,
        }

    def _explanation(self, art: TargetArtifact, canonical: dict[str, Any], frame: pd.DataFrame,
                     cal_logit: float) -> dict[str, Any]:
        base_raw, raw = art.model.raw_contributions(frame)
        per_feature: dict[str, float] = {}
        for value, origin in zip(raw[0], art.model.origins, strict=True):
            per_feature[origin] = per_feature.get(origin, 0.0) + float(value)
        a, b = art.platt.a, art.platt.b
        rows = []
        for fid, c_raw in per_feature.items():
            f = self.by_id[fid]
            supplied = canonical[fid]
            imputed = supplied == self.unknown
            value = art.reference.imputation[fid] if imputed else supplied
            c = a * c_raw
            rows.append({
                "feature": fid, "display": f.display, "value": value,
                "display_value": (f"Unknown (imputed {display_value(f, value)})" if imputed else display_value(f, value)),
                "contribution": c, "direction": "up" if c > 0 else "down" if c < 0 else "neutral",
                "strength": strength(abs(c), art.strength), "group": f.group,
                "value_status": "imputed" if imputed else "computed" if f.input_mode == "computed" else "provided",
                "imputation": ({"method": "median" if f.kind == "continuous" else "mode", "value": value,
                                "fit_scope": "fold_outer_training" if self.mode == "oof" else "full_cohort"}
                               if imputed else None),
                "cohort_comparison": None if imputed else art.reference.comparison(art.target, fid, value),
            })
        rows.sort(key=lambda r: (-abs(r["contribution"]), r["feature"]))
        mass = math.fsum(abs(r["contribution"]) for r in rows)
        for r in rows:
            r["relative_share"] = None if mass == 0 else abs(r["contribution"]) / mass
        groups: dict[str, float] = {}
        for r in rows:
            groups[r["group"]] = groups.get(r["group"], 0.0) + r["contribution"]
        return {
            "target": art.target, "space": "calibrated_log_odds",
            "base_calibrated_logit": a * float(base_raw[0]) + b, "calibrated_logit": cal_logit,
            "contributions": rows,
            "groups": {g: {"contribution": s, "strength": strength(abs(s), art.strength)} for g, s in groups.items()},
            "strength_cutpoints": dict(art.strength),
        }

    def _evidence(self, art: TargetArtifact, canonical: dict[str, Any], p: float, atypical_flag: bool,
                  atypical_t: dict[str, Any], exclude_id: int | None) -> dict[str, Any]:
        ref = art.reference
        size = len(ref.ids)
        similar = ref.similar(canonical, patient_id, exclude_id) if size >= 3 else []
        return {
            "target": art.target,
            "similar_patients": {
                "subtitle": "from this patient's outer-training cohort" if self.mode == "oof" else "from the training cohort",
                "status": "ok" if size >= 3 else "insufficient_evidence",
                "k_effective": len(similar), "reference_size": size, "patients": similar,
            },
            "evidence_ledger": ref.ledger(art.target, p),
            "atypical_profile": {
                "flag": atypical_flag, "distance_percentile": atypical_t["distance_percentile"],
                "excluded_unknown_features": atypical_t["excluded_unknown_features"],
                "message": ("This patient's feature profile is farther from the training cohort than most observed "
                            "profiles." if atypical_flag else None),
            },
            "stability_interval": None,
        }

    # -------------------------------------------------------------------------------------------- public API
    def predict(self, canonical: dict[str, Any]) -> dict[str, Any]:
        """Fast path (/predict): predictions + quality only. No SHAP, no evidence, no similarity."""
        quality, _ = self.quality(canonical)
        targets = {}
        for t, art in self.targets.items():
            frame = self._frame(art.reference.impute(canonical))
            cal_logit = float(art.platt.logit(art.model.margin(frame))[0])
            targets[t] = self._prediction(art, cal_logit, quality)
        return {"targets": targets, "quality": quality}

    def analyze(self, canonical: dict[str, Any], exclude_id: int | None = None,
                only: str | None = None) -> dict[str, Any]:
        """Predictions + explanations + evidence (all from the same artifacts). `only` limits to one target."""
        quality, per_target = self.quality(canonical)
        targets, explanations, evidence = {}, {}, {}
        for t, art in self.targets.items():
            frame = self._frame(art.reference.impute(canonical))
            cal_logit = float(art.platt.logit(art.model.margin(frame))[0])
            targets[t] = self._prediction(art, cal_logit, quality)
            if only and t != only:
                continue
            explanations[t] = self._explanation(art, canonical, frame, cal_logit)
            evidence[t] = self._evidence(art, canonical, targets[t]["probability"],
                                         quality["atypical_profile"]["flag"], per_target[t], exclude_id)
        return {"targets": targets, "explanations": explanations, "evidence": evidence, "quality": quality}

    def raw_feature_contributions(self, canonical: dict[str, Any]) -> dict[str, list[float]]:
        """|calibrated contribution| per registry feature, per target (for the OOF strength tertiles)."""
        out = {}
        for t, art in self.targets.items():
            frame = self._frame(art.reference.impute(canonical))
            _, raw = art.model.raw_contributions(frame)
            per: dict[str, float] = {}
            for value, origin in zip(raw[0], art.model.origins, strict=True):
                per[origin] = per.get(origin, 0.0) + float(value)
            out[t] = [abs(art.platt.a * v) for v in per.values()]
        return out
