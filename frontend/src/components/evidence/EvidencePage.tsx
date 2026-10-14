// Screen 3 "Model Evidence" (plan §7, §12; D-035): official metrics vs benchmarks, confidence tiers, ROC/PR/reliability/
// threshold sweep, the guideline comparator, and the methods behind them. Every table and figure carries its scope label;
// training-set metrics are never shown, fold SDs are never called confidence intervals, and a missing value stays missing.
import { useQuery } from "@tanstack/react-query";
import { useRef, useState, type KeyboardEvent } from "react";
import { TARGET_IDS, api, type Schemas, type TargetId } from "../../api/client";
import { SHORT } from "../wording";
import { ClinicalBenchmark } from "./ClinicalBenchmark";
import { ConfidenceTiers, type DisplayedTiers } from "./ConfidenceTiers";
import { Curves, type Figures } from "./Curves";
import { Card, DotIntervalChart, ExportButtons, InfoTip, N_FOLDS, Unavailable, countOf, f2 } from "./kit";
import { Methods } from "./Methods";
import { useBoundEvidence } from "./boundEvidence";

type Fmt = "pct" | "num2" | "num3";
type Better = "higher" | "lower" | "near1" | "near0";
interface MetricDef { key: string; label: string; fmt: Fmt; core: boolean; better: Better; help: string }
// The first six are what a clinician reads first; the rest stay one click away ("Show all metrics").
const METRICS: MetricDef[] = [
  { key: "roc_auc", label: "ROC-AUC", fmt: "num3", core: true, better: "higher",
    help: "Ranking ability: the chance a random positive patient scores above a random negative one. 0.5 = chance, 1 = perfect. Threshold-free." },
  { key: "recall", label: "Sensitivity", fmt: "pct", core: true, better: "higher",
    help: "Of patients with the label, the share predicted positive at the operating threshold t_op (recall)." },
  { key: "specificity", label: "Specificity", fmt: "pct", core: true, better: "higher",
    help: "Of patients without the label, the share predicted negative at t_op." },
  { key: "precision", label: "PPV", fmt: "pct", core: true, better: "higher",
    help: "Positive predictive value: of patients predicted positive, the share truly positive. Depends on prevalence, so it does not transfer to other populations." },
  { key: "npv", label: "NPV", fmt: "pct", core: true, better: "higher",
    help: "Negative predictive value: of patients predicted negative, the share truly negative. Depends on prevalence." },
  { key: "brier", label: "Brier score", fmt: "num3", core: true, better: "lower",
    help: "Mean squared error of the predicted probability (accuracy and calibration together). Lower is better; 0 = perfect." },
  { key: "pr_auc", label: "PR-AUC", fmt: "num3", core: false, better: "higher",
    help: "Area under the precision–recall curve. Its no-skill baseline is the prevalence, not 0.5." },
  { key: "accuracy", label: "Accuracy", fmt: "pct", core: false, better: "higher", help: "Share of all patients classified correctly at t_op." },
  { key: "balanced_accuracy", label: "Balanced accuracy", fmt: "pct", core: false, better: "higher", help: "Mean of sensitivity and specificity." },
  { key: "f1", label: "F1", fmt: "num3", core: false, better: "higher", help: "Harmonic mean of PPV and sensitivity." },
  { key: "cal_slope", label: "Calibration slope", fmt: "num2", core: false, better: "near1",
    help: "Best near 1. Below 1: predictions too extreme (overconfident); above 1: too cautious." },
  { key: "cal_intercept", label: "Calibration intercept", fmt: "num2", core: false, better: "near0",
    help: "Best near 0. Average over-prediction (negative) or under-prediction (positive) of risk." },
];
const BETTER_MARK: Record<Better, { sym: string; text: string }> = {
  higher: { sym: "↑", text: "higher is better" }, lower: { sym: "↓", text: "lower is better" },
  near1: { sym: "→1", text: "closest to 1 is best" }, near0: { sym: "→0", text: "closest to 0 is best" },
};
const MODEL_LABEL: Record<string, string> = {
  nested_cv_selected: "NOVARION (selected per fold)", benchmark_lr: "Logistic regression",
  benchmark_ebm: "EBM", benchmark_xgboost: "XGBoost", benchmark_catboost: "CatBoost",
  always_negative: "Always negative", always_positive: "Always positive", prior: "Prior probability",
};
const MODELS = ["nested_cv_selected", "benchmark_lr", "benchmark_ebm", "benchmark_xgboost", "benchmark_catboost"];
const BASELINES = new Set(["always_negative", "always_positive", "prior"]);
const SELECTED_HELP = "In each of the 25 outer folds, the inner cross-validation chose one configuration from the 92 "
  + "pre-registered ones (the simplest within one standard error of the best). This row scores that whole procedure, so "
  + "different folds may use different model families. Each benchmark row applies the same rule within one family.";
const fmt = (v: number, f: Fmt) => (f === "pct" ? `${(v * 100).toFixed(1)}%` : v.toFixed(f === "num3" ? 3 : 2));
const fmtSd = (v: number, f: Fmt) => (f === "pct" ? (v * 100).toFixed(1) : v.toFixed(f === "num3" ? 3 : 2));

/** Mean large, spread small underneath: the eye reads one number per cell. */
function cell(m: Schemas["MetricSummary"] | undefined, f: Fmt) {
  if (!m || m.mean == null) return <span className="text-slate-500" title="not defined in any fold">N/A</span>;
  return (
    <span className="inline-block text-right leading-tight">
      <span className="block text-sm font-semibold text-slate-900">
        {fmt(m.mean, f)}
        {m.n_na > 0 && <span className="text-amber-700" title={`undefined in ${m.n_na} of ${N_FOLDS} folds (reported as NA, never 0)`}>*</span>}
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
        ? `The model types' mean ROC-AUC values are close here (${Math.min(...aucs).toFixed(2)}–${Math.max(...aucs).toFixed(2)}, a gap smaller than the fold-to-fold spread). This is not a test of equivalence.`
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
  const exportRows = shown.flatMap((r) => metrics.map((m) => ({
    target, model: r.model, metric: m.key, mean: r.metrics[m.key]?.mean ?? null, sd: r.metrics[m.key]?.sd ?? null,
    folds_defined: r.metrics[m.key]?.n_defined ?? null, folds_na: r.metrics[m.key]?.n_na ?? null,
  })));
  return (
    <Card title={`Table 1 · official metrics · ${SHORT[target]}`} label="Official metrics"
          info="Outer-fold mean ± SD over 25 outer folds at the Layer A operating threshold. * = undefined in some folds (reported as NA, never 0). SD describes fold-to-fold variation; it is not a confidence interval."
          subtitle={<>outer-fold mean ± SD, {N_FOLDS} outer folds · prevalence {rows[0] ? `${(rows[0].prevalence * 100).toFixed(1)}%` : "—"} ·
            ± is the fold-to-fold SD, not a confidence interval</>}
          actions={
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
              <label className="flex items-center gap-1.5 font-medium text-slate-700">
                <input type="checkbox" checked={allMetrics} onChange={() => setAllMetrics(!allMetrics)} data-testid="metrics-all" />
                Show all metrics
              </label>
              <label className="flex items-center gap-1.5 font-medium text-slate-700">
                <input type="checkbox" checked={baselines} onChange={() => setBaselines(!baselines)} data-testid="metrics-baselines" />
                Show trivial baselines
              </label>
              <ExportButtons name={`metrics-${target}`} rows={exportRows} meta={{ scope: "outer-fold mean ± SD, 25 outer folds" }} />
            </div>
          }>
      <div className="-mx-4 overflow-x-auto px-4">
        <table className="w-full min-w-[40rem] tabular-nums" data-testid="metrics-table">
          <thead className="text-xs font-bold uppercase tracking-wide text-slate-600">
            <tr className="border-b-2 border-slate-200">
              <th scope="col" className="py-2 pr-4 text-left">Model</th>
              {metrics.map((m) => (
                <th key={m.key} scope="col" className="px-3 py-2 text-right align-bottom">
                  <span className="whitespace-nowrap">{m.label}</span>
                  <span className="block text-[10px] font-semibold normal-case tracking-normal text-slate-500"
                        title={BETTER_MARK[m.better].text}>{BETTER_MARK[m.better].sym} {BETTER_MARK[m.better].text.split(" ")[0]}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => {
              const ours = r.model === "nested_cv_selected";
              return (
                <tr key={r.model} className={`border-t border-slate-200 ${ours ? "bg-sky-50" : i % 2 ? "bg-slate-50/60" : ""}`}>
                  <th scope="row" className={`py-2.5 pr-4 text-left text-sm ${ours ? "font-bold text-slate-900" : "font-medium text-slate-700"}`}>
                    {MODEL_LABEL[r.model] ?? r.model}
                    {ours && <InfoTip text={SELECTED_HELP} label="What 'selected per fold' means" />}
                    {BASELINES.has(r.model) && <span className="block text-xs font-normal text-slate-500">trivial baseline</span>}
                  </th>
                  {metrics.map((m) => <td key={m.key} className="whitespace-nowrap px-3 py-2.5 text-right">{cell(r.metrics[m.key], m.fmt)}</td>)}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-slate-600">
        <b>Reading direction:</b> ↑ higher is better for ROC-AUC, PR-AUC, sensitivity, specificity, PPV, NPV, accuracy and F1;
        ↓ lower is better for the Brier score; calibration slope is best near 1 and intercept near 0. Sensitivity,
        specificity, PPV and NPV are measured at each fold&apos;s operating threshold; PPV and NPV also depend on prevalence.
      </p>
    </Card>
  );
}

function AucComparison({ rows, target }: { rows: Schemas["Table1Row"][]; target: TargetId }) {
  const data = MODELS.map((m) => {
    const r = rows.find((x) => x.model === m);
    const a = r?.metrics.roc_auc;
    return { model: m, mean: a?.mean ?? null, sd: a?.sd ?? null };
  });
  return (
    <Card title={`ROC-AUC by model type · ${SHORT[target]}`} testId="auc-comparison"
          subtitle={`dot = outer-fold mean; bar = ± 1 SD across ${N_FOLDS} outer folds (spread, not a confidence interval) · same folds for every model`}
          actions={<ExportButtons name={`auc-by-model-${target}`} rows={data.map((d) => ({ target, ...d }))}
                                  meta={{ scope: "outer-fold mean ± SD, 25 outer folds" }} />}>
      <DotIntervalChart ariaLabel={`ROC-AUC by model type for ${SHORT[target]}`} xLabel="ROC-AUC (0.5 = chance)"
                        domain={[0.5, 1]} ticks={[0.5, 0.6, 0.7, 0.8, 0.9, 1]} reference={{ x: 0.5 }} rowHeight={30}
                        cols="minmax(8rem,15rem) minmax(0,1fr) minmax(6rem,7rem)"
                        rows={data.map((d) => ({
                          key: d.model, label: MODEL_LABEL[d.model] ?? d.model, value: d.mean,
                          lo: d.mean != null && d.sd != null ? d.mean - d.sd : null,
                          hi: d.mean != null && d.sd != null ? d.mean + d.sd : null,
                          highlight: d.model === "nested_cv_selected", muted: d.model !== "nested_cv_selected",
                          right: d.mean == null ? "N/A" : `${d.mean.toFixed(3)}${d.sd == null ? "" : ` ± ${d.sd.toFixed(3)}`}`,
                        }))} />
      <p className="mt-2 text-xs text-slate-600">
        Overlapping spreads mean the folds do not separate the model types; similar means do not establish equivalence
        (no equivalence or superiority test was run).
      </p>
    </Card>
  );
}

/** Findings that are observed in this evaluation, worded so none reads as a clinical or superiority claim. */
function Findings({ forest, prevalence, tiers }: {
  forest: { target: TargetId; mean: number | null; sd: number | null }[]; prevalence: Partial<Record<TargetId, number>>;
  tiers: DisplayedTiers | undefined;
}) {
  const known = forest.filter((r) => r.mean != null);
  if (known.length < 2) return null;
  const best = [...known].sort((a, b) => b.mean! - a.mean!)[0]!;
  const rest = known.filter((r) => r !== best).map((r) => r.mean!);
  const noRegion = tiers ? TARGET_IDS.filter((t) => tiers.targets[t] && (tiers.targets[t]!.n_high_positive ?? 0) + (tiers.targets[t]!.n_high_negative ?? 0) === 0) : [];
  const prev = TARGET_IDS.filter((t) => prevalence[t] != null);
  return (
    <Card title="What this evaluation shows" testId="evidence-findings"
          subtitle="observed in internal validation on one cohort · no statistical test of differences between targets was run">
      <ul className="list-disc space-y-1.5 pl-5 text-sm text-slate-800">
        <li>
          Highest outer-fold ROC-AUC: <b>{SHORT[best.target]} {f2(best.mean!)}</b>{best.sd != null && ` ± ${f2(best.sd)}`};
          the other targets range {f2(Math.min(...rest))}–{f2(Math.max(...rest))}.
        </li>
        {prev.length > 1 && (
          <li>
            Prevalence differs by target ({prev.map((t) => `${SHORT[t]} ${(prevalence[t]! * 100).toFixed(0)}%`).join(", ")}), so
            PPV and NPV are not comparable across targets or transferable to other populations.
          </li>
        )}
        {tiers && noRegion.length > 0 && (
          <li>
            No qualified (high-support) region for {noRegion.map((t) => SHORT[t]).join(", ")}: every analysis for{" "}
            {noRegion.length === 1 ? "this target" : "these targets"} is shown as outside the qualified range. Predictions
            are still made.
          </li>
        )}
        <li>Internal validation only (nested cross-validation); there is no external or temporal validation.</li>
      </ul>
    </Card>
  );
}

type Section = "summary" | "performance" | "confidence" | "curves" | "clinical" | "methods";
const SECTIONS: readonly (readonly [Section, string])[] = [
  ["summary", "Summary"], ["performance", "Performance"], ["confidence", "Confidence tiers"], ["curves", "Curves"],
  ["clinical", "vs guideline score"], ["methods", "Methods & limitations"],
];

/** WAI-ARIA tabs: arrow keys move between tabs, Home/End jump to the ends. */
function useTabKeys<T extends string>(ids: readonly T[], value: T, set: (v: T) => void) {
  const refs = useRef<Partial<Record<T, HTMLButtonElement | null>>>({});
  const onKeyDown = (e: KeyboardEvent) => {
    const i = ids.indexOf(value);
    const next = e.key === "ArrowRight" ? ids[(i + 1) % ids.length] : e.key === "ArrowLeft" ? ids[(i - 1 + ids.length) % ids.length]
      : e.key === "Home" ? ids[0] : e.key === "End" ? ids[ids.length - 1] : undefined;
    if (next === undefined) return;
    e.preventDefault();
    set(next);
    refs.current[next]?.focus();
  };
  return { refs, onKeyDown };
}

const SECTION_IDS = SECTIONS.map(([id]) => id);

export function EvidencePage() {
  const evaluation = useQuery({ queryKey: ["evaluation"], queryFn: api.evaluation, staleTime: Infinity });
  const tiers = useBoundEvidence<DisplayedTiers>("displayed_tiers");
  const [target, setTarget] = useState<TargetId>("cad");
  const [section, setSection] = useState<Section>("summary");
  const targetTabs = useTabKeys(TARGET_IDS, target, setTarget);
  const sectionTabs = useTabKeys(SECTION_IDS, section, setSection);
  if (evaluation.isError) return <p className="p-6 text-sm text-red-700">Evaluation unavailable.</p>;
  if (!evaluation.data) return <p className="p-6 text-sm text-slate-500">Loading model evidence…</p>;
  const ev = evaluation.data.data;
  const allFigures = (ev.figures ?? {}) as Record<string, Figures>;
  const figures = allFigures[target] ?? {};
  const selected = (t: TargetId) => ev.table1.find((r) => r.target === t && r.model === "nested_cv_selected");
  const forest = TARGET_IDS.map((t) => {
    const row = selected(t);
    // Absent stays absent (audit R11): never a plausible default for a scientific measurement.
    return { target: t, mean: row?.metrics.roc_auc?.mean ?? null, sd: row?.metrics.roc_auc?.sd ?? null };
  });
  const nPatients = tiers.data?.n_patients ?? 303;
  const prevalence: Partial<Record<TargetId, number>> = {};
  for (const t of TARGET_IDS) {
    const p = ev.table1.find((r) => r.target === t)?.prevalence;
    if (p != null) prevalence[t] = p;
  }
  const positives = (t: TargetId) => countOf(prevalence[t], nPatients);
  const t1 = ev.table1.filter((r) => r.target === target);
  const core = selected(target);

  return (
    <div className="mx-auto max-w-7xl space-y-4 p-4" data-testid="evidence-page">
      <header className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-bold text-slate-900">Model evidence</h1>
            <p className="text-sm text-slate-600" data-testid="evidence-identity">
              Model v{ev.model_version} · {nPatients} patients, one public cohort (Extension of Z-Alizadeh Sani, UCI #411) ·
              internal validation only: nested cross-validation, 5-fold × 5 repeats outer ({N_FOLDS} folds), 5-fold inner
            </p>
          </div>
          <div className="flex flex-wrap gap-1" role="tablist" aria-label="Target" onKeyDown={targetTabs.onKeyDown}>
            {TARGET_IDS.map((t) => {
              const pos = positives(t);
              return (
                <button key={t} type="button" role="tab" aria-selected={t === target} tabIndex={t === target ? 0 : -1}
                        ref={(el) => { targetTabs.refs.current[t] = el; }} onClick={() => setTarget(t)} data-testid={`evidence-${t}`}
                        title={pos != null ? `${pos} of ${nPatients} label-positive` : undefined}
                        className={`rounded-md px-3.5 py-1.5 text-sm font-semibold leading-tight focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600 ${
                          t === target ? "bg-slate-900 text-white" : "bg-white text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50"}`}>
                  {SHORT[t]}
                  {pos != null && <span className={`block text-[10px] font-medium ${t === target ? "text-slate-300" : "text-slate-500"}`}>{pos}/{nPatients} pos.</span>}
                </button>
              );
            })}
          </div>
        </div>
        <p role="note" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-950"
           data-testid="evidence-disclaimer">
          Research and education only. These are internal-evaluation results on one cohort of {nPatients} patients; they do
          not show that NOVARION is a validated diagnostic or treatment tool, and they do not transfer to other populations
          without external validation.
        </p>
      </header>

      <div className="-mx-4 overflow-x-auto px-4">
        <div className="flex min-w-max gap-1 border-b border-slate-200" role="tablist" aria-label="Evidence sections"
             onKeyDown={sectionTabs.onKeyDown}>
          {SECTIONS.map(([id, label]) => (
            <button key={id} type="button" role="tab" id={`evidence-tab-${id}`} aria-controls="evidence-panel"
                    aria-selected={section === id} tabIndex={section === id ? 0 : -1}
                    ref={(el) => { sectionTabs.refs.current[id] = el; }} onClick={() => setSection(id)}
                    data-testid={`evidence-section-${id}`}
                    className={`-mb-px whitespace-nowrap border-b-2 px-4 py-2 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-sky-600 ${
                      section === id ? "border-slate-900 text-slate-900" : "border-transparent text-slate-600 hover:text-slate-900"}`}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div id="evidence-panel" role="tabpanel" aria-labelledby={`evidence-tab-${section}`} className="space-y-4">
        {section === "summary" && (
          <>
            <div>
              <p className="mb-2 text-xs text-slate-600">
                {SHORT[target]} · outer-fold mean ± SD over {N_FOLDS} outer folds · threshold metrics at the operating threshold t_op
              </p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" data-testid="evidence-key-numbers">
                {METRICS.filter((m) => m.core && m.key !== "brier").map((m) => {
                  const v = core?.metrics[m.key];
                  return (
                    <div key={m.key} className="rounded-lg border border-slate-200 bg-white p-4">
                      <p className="text-sm font-semibold text-slate-600">
                        {m.label} · {SHORT[target]}<InfoTip text={m.help} label={`About ${m.label}`} />
                      </p>
                      <p className="mt-1 text-3xl font-bold tabular-nums text-slate-900">
                        {v?.mean != null ? fmt(v.mean, m.fmt === "num3" ? "num2" : m.fmt) : "N/A"}
                      </p>
                      {v?.sd != null && <p className="text-sm text-slate-500">± {fmtSd(v.sd, m.fmt === "num3" ? "num2" : m.fmt)} across folds</p>}
                      {v != null && v.n_na > 0 && <p className="text-xs text-amber-800">defined in {v.n_defined} of {N_FOLDS} folds</p>}
                    </div>
                  );
                })}
              </div>
            </div>
            <Card title="ROC-AUC by target" testId="forest"
                  subtitle={`dot = outer-fold mean; bar = ± 1 SD across ${N_FOLDS} outer folds (spread, not a confidence interval) · 0.5 = no ranking ability · select a row to open its full performance`}
                  actions={<ExportButtons name="auc-by-target" meta={{ scope: "outer-fold mean ± SD, 25 outer folds" }}
                                          rows={forest.map((r) => ({ ...r, n: nPatients, n_positive: positives(r.target) }))} />}>
              <DotIntervalChart ariaLabel="ROC-AUC by target, outer-fold mean and standard deviation" rowHeight={44}
                                xLabel="ROC-AUC" domain={[0.5, 1]} ticks={[0.5, 0.6, 0.7, 0.8, 0.9, 1]}
                                reference={{ x: 0.5 }} cols="minmax(5.5rem,8rem) minmax(0,1fr) minmax(4.75rem,6.5rem)"
                                onSelect={(t) => { setTarget(t as TargetId); setSection("performance"); }}
                                rows={forest.map((r) => {
                                  const pos = positives(r.target);
                                  return {
                                    key: r.target, value: r.mean, highlight: r.target === target,
                                    label: (
                                      <>
                                        <span className="block">{SHORT[r.target]}</span>
                                        <span className="block text-[11px] font-normal text-slate-500">{pos != null ? `${pos}/${nPatients} pos.` : `n ${nPatients}`}</span>
                                      </>
                                    ),
                                    lo: r.mean != null && r.sd != null ? r.mean - r.sd : null,
                                    hi: r.mean != null && r.sd != null ? r.mean + r.sd : null,
                                    testId: `forest-row-${r.target}`, ariaLabel: `Open the ${SHORT[r.target]} performance`,
                                    right: (
                                      <span className="block text-sm font-semibold text-slate-900" data-testid={`forest-value-${r.target}`}>
                                        {r.mean === null ? "N/A" : `${r.mean.toFixed(2)}${r.sd === null ? "" : ` ± ${r.sd.toFixed(2)}`}`}
                                      </span>
                                    ),
                                  };
                                })} />
            </Card>
            <Findings forest={forest} prevalence={prevalence} tiers={tiers.data} />
          </>
        )}

        {section === "performance" && (
          <>
            <Takeaway rows={t1} families={figures.selected_families} />
            <AucComparison rows={t1} target={target} />
            <MetricsTable key={target} rows={t1} target={target} />
            {figures.selected_families && (
              <p className="text-sm text-slate-600">
                Model family chosen in the {N_FOLDS} outer folds:{" "}
                {Object.entries(figures.selected_families).map(([f, n]) => `${FAMILY[f] ?? f} ${n}`).join(" · ")} ·
                calibration-guard events: {figures.calibration_guard_events ?? 0} · prevalence{" "}
                {prevalence[target] != null ? `${(prevalence[target]! * 100).toFixed(1)}%` : "—"}
                {positives(target) != null && ` (${positives(target)} of ${nPatients})`}
              </p>
            )}
          </>
        )}

        {section === "confidence" && <ConfidenceTiers table2={ev.table2} target={target} tiers={tiers} nPatients={nPatients} />}

        {section === "curves" && (
          <Curves figures={figures} target={target}
                  prAuc={core?.metrics.pr_auc ?? null} calSlope={core?.metrics.cal_slope ?? null}
                  calIntercept={core?.metrics.cal_intercept ?? null} />
        )}

        {section === "clinical" && <ClinicalBenchmark target={target} />}

        {section === "methods" && <Methods modelVersion={ev.model_version} identity={tiers.identity} />}
      </div>
      {!core && section !== "methods" && section !== "clinical" && (
        <Unavailable>No selected-model row for {SHORT[target]} in this evaluation bundle.</Unavailable>
      )}
    </div>
  );
}
