// Screen 3 "Model Evidence" (plan §7, §12): official metrics vs baselines, confidence tiers, ROC/PR/reliability/
// threshold sweep. Every table and figure carries its scope label; training-set metrics are never shown.
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { TARGET_IDS, api, type Schemas, type TargetId } from "../../api/client";
import { SHORT } from "../wording";
import { ClinicalBenchmark } from "./ClinicalBenchmark";
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

type Fmt = "pct" | "num2" | "num3";
interface MetricDef { key: string; label: string; fmt: Fmt; core: boolean; help: string }
// The first six are what a clinician reads first; the rest stay one click away ("Show all metrics").
const METRICS: MetricDef[] = [
  { key: "roc_auc", label: "ROC-AUC", fmt: "num2", core: true, help: "Ranking ability: 0.5 = chance, 1 = perfect." },
  { key: "recall", label: "Sensitivity", fmt: "pct", core: true, help: "Share of label-positive patients predicted positive (recall)." },
  { key: "specificity", label: "Specificity", fmt: "pct", core: true, help: "Share of label-negative patients predicted negative." },
  { key: "precision", label: "PPV", fmt: "pct", core: true, help: "Of patients predicted positive, the share truly positive (precision)." },
  { key: "npv", label: "NPV", fmt: "pct", core: true, help: "Of patients predicted negative, the share truly negative." },
  { key: "brier", label: "Brier score", fmt: "num3", core: true, help: "Mean squared error of the probability; lower is better." },
  { key: "pr_auc", label: "PR-AUC", fmt: "num2", core: false, help: "Area under the precision-recall curve." },
  { key: "accuracy", label: "Accuracy", fmt: "pct", core: false, help: "Share of all patients classified correctly." },
  { key: "balanced_accuracy", label: "Balanced accuracy", fmt: "pct", core: false, help: "Mean of sensitivity and specificity." },
  { key: "f1", label: "F1", fmt: "num2", core: false, help: "Harmonic mean of PPV and sensitivity." },
  { key: "cal_slope", label: "Calibration slope", fmt: "num2", core: false, help: "1 = ideal; below 1 = overconfident." },
  { key: "cal_intercept", label: "Calibration intercept", fmt: "num2", core: false, help: "0 = ideal; average over- or under-prediction." },
];
const MODEL_LABEL: Record<string, string> = {
  nested_cv_selected: "NOVARION (selected per fold)", benchmark_lr: "Logistic regression",
  benchmark_ebm: "EBM", benchmark_xgboost: "XGBoost", benchmark_catboost: "CatBoost",
  always_negative: "Always negative", always_positive: "Always positive", prior: "Prior probability",
};
const BASELINES = new Set(["always_negative", "always_positive", "prior"]);
const p100 = (v: number | null | undefined) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);
const fmt = (v: number, f: Fmt) => (f === "pct" ? `${(v * 100).toFixed(1)}%` : v.toFixed(f === "num3" ? 3 : 2));
const fmtSd = (v: number, f: Fmt) => (f === "pct" ? (v * 100).toFixed(1) : v.toFixed(f === "num3" ? 3 : 2));

/** Mean large, spread small underneath: the eye reads one number per cell. */
function cell(m: Schemas["MetricSummary"] | undefined, f: Fmt) {
  if (!m || m.mean == null) return <span className="text-slate-400">N/A</span>;
  return (
    <span className="inline-block leading-tight">
      <span className="block text-sm font-semibold text-slate-900">
        {fmt(m.mean, f)}
        {m.n_na > 0 && <span className="text-amber-700" title={`undefined in ${m.n_na} folds (reported as NA, never 0)`}> *</span>}
      </span>
      {m.sd != null && <span className="block text-xs text-slate-500">± {fmtSd(m.sd, f)}</span>}
    </span>
  );
}

const FAMILY: Record<string, string> = { lr: "logistic regression", ebm: "EBM", xgboost: "XGBoost", catboost: "CatBoost" };

/** The rows are close on purpose: say so, so the closeness reads as the finding rather than as noise. */
function Takeaway({ rows, families }: { rows: Schemas["Table1Row"][]; families?: Record<string, number> }) {
  const models = rows.filter((r) => !BASELINES.has(r.model) && r.metrics.roc_auc?.mean != null);
  const aucs = models.map((r) => r.metrics.roc_auc!.mean!);
  if (aucs.length < 2) return null;
  const minSd = Math.min(...models.map((r) => r.metrics.roc_auc!.sd ?? 0));
  const similar = Math.max(...aucs) - Math.min(...aucs) <= minSd; // the gap is smaller than any one model's fold-to-fold SD
  const top = families ? Object.entries(families).sort((a, b) => b[1] - a[1])[0] : undefined;
  const total = families ? Object.values(families).reduce((a, b) => a + b, 0) : 0;
  return (
    <p className="rounded-lg bg-sky-50 px-4 py-3 text-sm font-medium text-slate-800" data-testid="metrics-takeaway">
      {similar
        ? `All model types perform about the same here (ROC-AUC ${Math.min(...aucs).toFixed(2)}–${Math.max(...aucs).toFixed(2)}, a gap smaller than the fold-to-fold spread).`
        : `ROC-AUC ranges ${Math.min(...aucs).toFixed(2)}–${Math.max(...aucs).toFixed(2)} across model types.`}
      {top && ` The selection rule picked ${FAMILY[top[0]] ?? top[0]} in ${top[1]} of ${total} folds: the simplest model that does as well.`}
    </p>
  );
}

function MetricsTable({ rows, target }: { rows: Schemas["Table1Row"][]; target: TargetId }) {
  const [allMetrics, setAllMetrics] = useState(false);
  const [baselines, setBaselines] = useState(false);
  const metrics = METRICS.filter((m) => allMetrics || m.core);
  const shown = rows.filter((r) => baselines || !BASELINES.has(r.model));
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4" aria-label="Official metrics">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-bold text-slate-900"
            title="Outer-fold mean ± SD over 25 outer folds (Layer A operating threshold). * = undefined in some folds (reported as NA, never 0). Benchmarks apply the same selection rule within one family.">
          Table 1 · official metrics · {SHORT[target]} <span className="font-normal text-slate-500">ⓘ</span>
        </h2>
        <div className="flex gap-4 text-sm">
          <label className="flex items-center gap-1.5 font-medium text-slate-700">
            <input type="checkbox" checked={allMetrics} onChange={() => setAllMetrics(!allMetrics)} data-testid="metrics-all" />
            Show all metrics
          </label>
          <label className="flex items-center gap-1.5 font-medium text-slate-700">
            <input type="checkbox" checked={baselines} onChange={() => setBaselines(!baselines)} data-testid="metrics-baselines" />
            Show trivial baselines
          </label>
        </div>
      </div>
      <p className="mt-0.5 text-sm text-slate-600">outer-fold mean ± SD, 25 outer folds · prevalence {p100(rows[0]?.prevalence)}</p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full tabular-nums" data-testid="metrics-table">
          <thead className="text-left text-xs font-bold uppercase tracking-wide text-slate-600">
            <tr>
              <th className="py-2 pr-4">Model</th>
              {metrics.map((m) => <th key={m.key} className="px-3 py-2" title={m.help}>{m.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const ours = r.model === "nested_cv_selected";
              return (
                <tr key={r.model} className={`border-t border-slate-200 ${ours ? "bg-sky-50" : ""}`}>
                  <td className={`py-2.5 pr-4 text-sm ${ours ? "font-bold text-slate-900" : "font-medium text-slate-700"}`}>
                    {MODEL_LABEL[r.model] ?? r.model}
                    {BASELINES.has(r.model) && <span className="block text-xs font-normal text-slate-500">baseline</span>}
                  </td>
                  {metrics.map((m) => <td key={m.key} className="whitespace-nowrap px-3 py-2.5">{cell(r.metrics[m.key], m.fmt)}</td>)}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
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
                {r.mean.toFixed(2)} ± {r.sd.toFixed(2)}
              </text>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}

type Section = "summary" | "performance" | "confidence" | "curves" | "clinical";
const SECTIONS: readonly (readonly [Section, string])[] = [
  ["summary", "Summary"], ["performance", "Performance"], ["confidence", "Confidence tiers"], ["curves", "Curves"],
  ["clinical", "vs guideline score"],
];

export function EvidencePage() {
  const evaluation = useQuery({ queryKey: ["evaluation"], queryFn: api.evaluation, staleTime: Infinity });
  const [target, setTarget] = useState<TargetId>("cad");
  const [section, setSection] = useState<Section>("summary");
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

  const core = ev.table1.find((r) => r.target === target && r.model === "nested_cv_selected");

  return (
    <div className="mx-auto max-w-7xl space-y-4 p-4" data-testid="evidence-page">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Model evidence</h1>
          <p className="text-sm text-slate-600">
            Model v{ev.model_version} · 303 patients, one public cohort · internal validation only (nested cross-validation)
          </p>
        </div>
        <div className="flex gap-1" role="tablist" aria-label="Target">
          {TARGET_IDS.map((t) => (
            <button key={t} type="button" role="tab" aria-selected={t === target} onClick={() => setTarget(t)}
                    data-testid={`evidence-${t}`}
                    className={`rounded-md px-4 py-1.5 text-sm font-semibold ${t === target ? "bg-slate-900 text-white" : "bg-white text-slate-700 ring-1 ring-slate-300"}`}>
              {SHORT[t]}
            </button>
          ))}
        </div>
      </header>

      <div className="flex flex-wrap gap-1 border-b border-slate-200" role="tablist" aria-label="Evidence sections">
        {SECTIONS.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={section === id} onClick={() => setSection(id)}
                  data-testid={`evidence-section-${id}`}
                  className={`-mb-px border-b-2 px-4 py-2 text-sm font-semibold ${
                    section === id ? "border-slate-900 text-slate-900" : "border-transparent text-slate-600 hover:text-slate-900"}`}>
            {label}
          </button>
        ))}
      </div>

      {section === "summary" && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5" data-testid="evidence-key-numbers">
            {METRICS.filter((m) => m.core && m.key !== "brier").map((m) => {
              const v = core?.metrics[m.key];
              return (
                <div key={m.key} className="rounded-lg border border-slate-200 bg-white p-4" title={m.help}>
                  <p className="text-sm font-semibold text-slate-600">{m.label} · {SHORT[target]}</p>
                  <p className="mt-1 text-3xl font-bold tabular-nums text-slate-900">{v?.mean != null ? fmt(v.mean, m.fmt) : "N/A"}</p>
                  {v?.sd != null && <p className="text-sm text-slate-500">± {fmtSd(v.sd, m.fmt)} across folds</p>}
                </div>
              );
            })}
          </div>
          <div className="max-w-3xl"><Forest rows={forest} selected={target} onSelect={setTarget} /></div>
        </div>
      )}

      {section === "performance" && (
        <div className="space-y-3">
          <Takeaway rows={t1} families={figures.selected_families} />
          <MetricsTable key={target} rows={t1} target={target} />
          {figures.selected_families && (
            <p className="text-sm text-slate-600">
              Model family chosen in the 25 outer folds:{" "}
              {Object.entries(figures.selected_families).map(([f, n]) => `${FAMILY[f] ?? f} ${n}`).join(" · ")} ·
              calibration-guard events: {figures.calibration_guard_events ?? 0}
            </p>
          )}
        </div>
      )}

      {section === "confidence" && (
        <section className="rounded-lg border border-slate-200 bg-white p-4" aria-label="Confidence tiers">
          <h2 className="text-base font-bold text-slate-900"
              title="Pooled OOF (prespecified repeat), patient-level bootstrap 95% CI. A region qualifies only if the Wilson lower bound meets the pre-registered PPV ≥ 90% / NPV ≥ 95% (targets never moved).">
            Table 2 · confidence tiers <span className="font-normal text-slate-500">ⓘ</span>
          </h2>
          <p className="mt-0.5 text-sm text-slate-600">pooled OOF (prespecified repeat) · share of patients in each tier</p>
          <table className="mt-3 w-full tabular-nums">
            <thead className="text-left text-xs font-bold uppercase tracking-wide text-slate-600">
              <tr><th className="py-2">Target</th><th>Validated positive</th><th>PPV [95% CI]</th><th>Validated negative</th><th>NPV [95% CI]</th><th>Standard</th></tr>
            </thead>
            <tbody className="text-sm">
              {ev.table2.map((r) => (
                <tr key={r.target} className={`border-t border-slate-200 ${r.target === target ? "bg-sky-50 font-semibold" : ""}`}>
                  <td className="py-2.5 font-semibold">{SHORT[r.target as TargetId]}</td>
                  <td>{p100(r.pct_high_positive)}</td>
                  <td>{p100(r.ppv)}{r.ppv_ci && <span className="text-xs text-slate-500"> [{p100(r.ppv_ci[0])}–{p100(r.ppv_ci[1])}]</span>}</td>
                  <td>{p100(r.pct_high_negative)}</td>
                  <td>{p100(r.npv)}{r.npv_ci && <span className="text-xs text-slate-500"> [{p100(r.npv_ci[0])}–{p100(r.npv_ci[1])}]</span>}</td>
                  <td>{p100(r.pct_low_confidence)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-sm text-slate-700">
            Every patient gets a prediction. A validated range met the pre-registered PPV ≥ 90% / NPV ≥ 95% target;
            a standard prediction lies outside those ranges, so no extra PPV/NPV is quoted for it.
          </p>
        </section>
      )}

      {section === "curves" && (figures.roc && figures.pr && figures.reliability ? (
        <div className="grid gap-4 md:grid-cols-2" data-testid="evidence-figures">
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
      ))}

      {section === "clinical" && <ClinicalBenchmark target={target} />}
    </div>
  );
}
