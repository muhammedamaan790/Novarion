// Screen 3 "Model Evidence" (plan §7, §12): official metrics vs baselines, confidence tiers, ROC/PR/reliability/
// threshold sweep. Every table and figure carries its scope label; training-set metrics are never shown.
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { TARGET_IDS, api, type Schemas, type TargetId } from "../../api/client";
import { SHORT } from "../wording";
import { LineChart } from "./LineChart";

const C = { primary: "#2a78d6", second: "#1baf7a", third: "#eda100" }; // validated (dataviz validator, light)

interface Curve { x?: number[]; fpr?: number[]; tpr?: number[]; recall?: number[]; precision?: number[]; lo: number[]; hi: number[]; prevalence?: number }
interface Figures {
  scope?: string;
  roc?: Curve;
  pr?: Curve;
  reliability?: { mean_predicted: number; observed_rate: number; n: number; lo: number | null; hi: number | null }[];
  threshold_sweep?: { t: number; ppv: number | null; npv: number | null; coverage_above: number; n_above?: number; n_below?: number }[];
  deployed_thresholds?: { t_op: number; t_neg: number | null; t_pos: number | null } | null;
  selected_families?: Record<string, number>;
  calibration_guard_events?: number;
  table2_auc?: number | null;
  table2_auc_ci?: number[] | null;
}

const METRICS: [string, string][] = [
  ["roc_auc", "ROC-AUC"], ["pr_auc", "PR-AUC"], ["accuracy", "Accuracy"], ["balanced_accuracy", "Bal. acc."],
  ["precision", "Precision"], ["recall", "Recall"], ["f1", "F1"], ["specificity", "Specificity"], ["npv", "NPV"],
  ["brier", "Brier"], ["cal_slope", "Cal. slope"], ["cal_intercept", "Cal. intercept"],
];
const MODEL_LABEL: Record<string, string> = {
  nested_cv_selected: "Selected per fold (nested CV)", benchmark_lr: "Benchmark · logistic regression",
  benchmark_ebm: "Benchmark · EBM", benchmark_xgboost: "Benchmark · XGBoost", benchmark_catboost: "Benchmark · CatBoost",
  always_negative: "Baseline · always negative", always_positive: "Baseline · always positive", prior: "Baseline · prior probability",
};
const p100 = (v: number | null | undefined) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);

function cell(m: Schemas["MetricSummary"] | undefined) {
  if (!m || m.mean == null) return <span className="text-slate-500">N/A</span>;
  return (
    <span>
      {m.mean.toFixed(3)}
      {m.sd != null && <span className="text-slate-500"> ± {m.sd.toFixed(3)}</span>}
      {m.n_na > 0 && <span className="text-amber-700" title={`undefined in ${m.n_na} folds`}> *</span>}
    </span>
  );
}

function Forest({ rows, selected, onSelect }: {
  rows: { target: TargetId; mean: number; sd: number }[]; selected: TargetId; onSelect: (t: TargetId) => void;
}) {
  const W = 560;
  const rowH = 30;
  const left = 56;
  const right = 110;
  const x = (v: number) => left + ((v - 0.5) / 0.5) * (W - left - right);
  return (
    <figure className="rounded-lg border border-slate-200 bg-white p-3">
      <figcaption className="mb-1">
        <span className="block text-sm font-semibold text-slate-900">ROC-AUC by target</span>
        <span className="block text-[11px] text-slate-500">
          outer-fold mean ± SD (25 outer folds, nested CV) · 0.5 = no ranking ability · click a row to inspect it
        </span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${rows.length * rowH + 26}`} className="w-full" role="img"
           aria-label="ROC-AUC by target, outer-fold mean and standard deviation">
        {[0.5, 0.6, 0.7, 0.8, 0.9, 1].map((t) => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={4} y2={rows.length * rowH + 4} stroke={t === 0.5 ? "#94a3b8" : "#eef0f3"} />
            <text x={x(t)} y={rows.length * rowH + 18} textAnchor="middle" className="fill-slate-500 text-[10px]">{t.toFixed(1)}</text>
          </g>
        ))}
        {rows.map((r, i) => {
          const cy = 4 + i * rowH + rowH / 2;
          const active = r.target === selected;
          return (
            <g key={r.target} onClick={() => onSelect(r.target)} className="cursor-pointer">
              <rect x={0} y={cy - rowH / 2} width={W} height={rowH} fill={active ? "#f1f5f9" : "transparent"} />
              <text x={8} y={cy + 4} className={`text-[12px] ${active ? "fill-slate-900 font-semibold" : "fill-slate-700"}`}>
                {SHORT[r.target]}
              </text>
              <line x1={x(Math.max(0.5, r.mean - r.sd))} x2={x(Math.min(1, r.mean + r.sd))} y1={cy} y2={cy}
                    stroke={C.primary} strokeWidth="2" strokeLinecap="round" />
              <circle cx={x(r.mean)} cy={cy} r="5" fill={C.primary} stroke="#fff" strokeWidth="2" />
              <text x={W - right + 8} y={cy + 4} className="fill-slate-700 text-[11px] tabular-nums">
                {r.mean.toFixed(3)} ± {r.sd.toFixed(3)}
              </text>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}

export function EvidencePage() {
  const evaluation = useQuery({ queryKey: ["evaluation"], queryFn: api.evaluation, staleTime: Infinity });
  const [target, setTarget] = useState<TargetId>("cad");
  if (evaluation.isError) return <p className="p-6 text-sm text-red-700">Evaluation unavailable.</p>;
  if (!evaluation.data) return <p className="p-6 text-sm text-slate-500">Loading model evidence…</p>;
  const ev = evaluation.data.data;
  const figures = ((ev.figures ?? {}) as Record<string, Figures>)[target] ?? {};
  const forest = TARGET_IDS.map((t) => {
    const row = ev.table1.find((r) => r.target === t && r.model === "nested_cv_selected");
    return { target: t, mean: row?.metrics.roc_auc?.mean ?? 0.5, sd: row?.metrics.roc_auc?.sd ?? 0 };
  });
  const t1 = ev.table1.filter((r) => r.target === target);
  const thr = figures.deployed_thresholds;
  const sweep = figures.threshold_sweep ?? [];
  const N_MIN = 15; // same minimum as a qualifying confidence region (targets.yaml n_min_region)
  const masked = (v: number | null, n: number | undefined) => (n != null && n < N_MIN ? null : v);

  return (
    <div className="mx-auto max-w-7xl space-y-4 p-4" data-testid="evidence-page">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-lg font-bold text-slate-900">Model evidence</h1>
          <p className="text-xs text-slate-600">
            Model v{ev.model_version} · Extension of Z-Alizadeh Sani (UCI #411), 303 patients, single public cohort ·
            internal validation only (nested cross-validation); no external validation.
          </p>
        </div>
        <div className="flex gap-1" role="tablist" aria-label="Target">
          {TARGET_IDS.map((t) => (
            <button key={t} type="button" role="tab" aria-selected={t === target} onClick={() => setTarget(t)}
                    data-testid={`evidence-${t}`}
                    className={`rounded px-3 py-1 text-xs font-semibold ${t === target ? "bg-slate-900 text-white" : "bg-white text-slate-700 shadow-sm"}`}>
              {SHORT[t]}
            </button>
          ))}
        </div>
      </header>

      <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        <Forest rows={forest} selected={target} onSelect={setTarget} />
        <section className="rounded-lg border border-slate-200 bg-white p-3" aria-label="Confidence tiers">
          <h2 className="text-sm font-semibold text-slate-900">Table 2 · confidence tiers</h2>
          <p className="text-[11px] text-slate-500">
            pooled OOF (prespecified repeat), patient-level bootstrap 95% CI · regions qualify only if the Wilson lower
            bound meets the pre-registered PPV ≥ 90% / NPV ≥ 95% (targets never moved)
          </p>
          <table className="mt-2 w-full text-xs tabular-nums">
            <thead className="text-left text-[11px] text-slate-500">
              <tr><th className="py-1">Target</th><th>High-positive</th><th>PPV [CI]</th><th>High-negative</th><th>NPV [CI]</th><th>LOW</th></tr>
            </thead>
            <tbody>
              {ev.table2.map((r) => (
                <tr key={r.target} className={`border-t border-slate-100 ${r.target === target ? "bg-slate-50 font-medium" : ""}`}>
                  <td className="py-1">{SHORT[r.target as TargetId]}</td>
                  <td>{p100(r.pct_high_positive)}</td>
                  <td>{p100(r.ppv)}{r.ppv_ci ? ` [${p100(r.ppv_ci[0])}–${p100(r.ppv_ci[1])}]` : ""}</td>
                  <td>{p100(r.pct_high_negative)}</td>
                  <td>{p100(r.npv)}{r.npv_ci ? ` [${p100(r.npv_ci[0])}–${p100(r.npv_ci[1])}]` : ""}</td>
                  <td>{p100(r.pct_low_confidence)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-[11px] text-slate-600">
            Every patient still receives a binary prediction. LOW means the score lies outside a region that met the
            pre-registered target in training-side validation, so no PPV/NPV is quoted for it.
          </p>
        </section>
      </div>

      <section className="overflow-x-auto rounded-lg border border-slate-200 bg-white p-3" aria-label="Official metrics">
        <h2 className="text-sm font-semibold text-slate-900">Table 1 · official metrics · {SHORT[target]}</h2>
        <p className="text-[11px] text-slate-500">
          outer-fold mean ± SD over 25 outer folds (Layer A operating threshold) · prevalence {p100(t1[0]?.prevalence)} ·
          * = undefined in some folds (reported as NA, never 0) · benchmarks apply the same selection rule within one family
        </p>
        <table className="mt-2 w-full min-w-[900px] text-xs tabular-nums">
          <thead className="text-left text-[11px] text-slate-500">
            <tr><th className="py-1 pr-2">Model</th>{METRICS.map(([, l]) => <th key={l} className="pr-2">{l}</th>)}</tr>
          </thead>
          <tbody>
            {t1.map((r) => (
              <tr key={r.model} className={`border-t border-slate-100 ${r.model === "nested_cv_selected" ? "font-semibold text-slate-900" : "text-slate-700"}`}>
                <td className="py-1 pr-2">{MODEL_LABEL[r.model] ?? r.model}</td>
                {METRICS.map(([k]) => <td key={k} className="whitespace-nowrap pr-2">{cell(r.metrics[k])}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
        {figures.selected_families && (
          <p className="mt-2 text-[11px] text-slate-600">
            Family selected across the 25 outer folds (inner-CV AUC → 1-SE rule → simplest):{" "}
            {Object.entries(figures.selected_families).map(([f, n]) => `${f} ${n}`).join(" · ")} · calibration-guard
            events: {figures.calibration_guard_events ?? 0}
          </p>
        )}
      </section>

      {figures.roc && figures.pr && figures.reliability ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4" data-testid="evidence-figures">
          <LineChart title={`ROC · ${SHORT[target]}`}
                     caption={`${figures.scope ?? ""}${figures.table2_auc ? ` · AUC ${figures.table2_auc.toFixed(3)}` : ""}${
                       figures.table2_auc_ci ? ` [${figures.table2_auc_ci[0]!.toFixed(3)}–${figures.table2_auc_ci[1]!.toFixed(3)}]` : ""}`}
                     xLabel="False-positive rate" yLabel="True-positive rate" diagonal
                     series={[{ id: "roc", label: "ROC", color: C.primary, x: figures.roc.fpr!, y: figures.roc.tpr!,
                                lo: figures.roc.lo, hi: figures.roc.hi }]} />
          <LineChart title={`Precision–recall · ${SHORT[target]}`} caption={`${figures.scope ?? ""}`}
                     xLabel="Recall" yLabel="Precision"
                     hline={{ y: figures.pr.prevalence ?? 0, label: "prevalence" }}
                     series={[{ id: "pr", label: "PR", color: C.primary, x: figures.pr.recall!, y: figures.pr.precision!,
                                lo: figures.pr.lo, hi: figures.pr.hi }]} />
          <LineChart title={`Reliability · ${SHORT[target]}`}
                     caption="pooled OOF; 5 quantile bins; bars = bootstrap 95% CI of the observed rate"
                     xLabel="Mean predicted probability" yLabel="Observed positive rate" diagonal
                     series={[{ id: "rel", label: "Observed", color: C.primary, points: true,
                                x: figures.reliability.map((b) => b.mean_predicted), y: figures.reliability.map((b) => b.observed_rate),
                                lo: figures.reliability.map((b) => b.lo), hi: figures.reliability.map((b) => b.hi) }]} />
          <LineChart title={`Threshold sweep · ${SHORT[target]}`}
                     caption="pooled OOF; measured PPV of p ≥ t, NPV of p < t (hidden where n < 15), coverage of p ≥ t; deployed thresholds marked"
                     xLabel="Threshold t" yLabel="Rate"
                     vlines={thr ? [{ x: thr.t_op, label: "t_op" }, ...(thr.t_neg != null ? [{ x: thr.t_neg, label: "t_neg" }] : []),
                                    ...(thr.t_pos != null ? [{ x: thr.t_pos, label: "t_pos" }] : [])] : []}
                     series={[
                       { id: "ppv", label: "PPV", color: C.primary, x: sweep.map((s) => s.t), y: sweep.map((s) => masked(s.ppv, s.n_above)) },
                       { id: "npv", label: "NPV", color: C.second, x: sweep.map((s) => s.t), y: sweep.map((s) => masked(s.npv, s.n_below)) },
                       { id: "cov", label: "Coverage", color: C.third, dashed: true, x: sweep.map((s) => s.t), y: sweep.map((s) => s.coverage_above) },
                     ]} />
        </div>
      ) : (
        <p className="text-sm text-slate-500">Figures are not available for this bundle.</p>
      )}
    </div>
  );
}
