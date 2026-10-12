import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, TARGET_IDS, type Evaluation, type Meta, type Schemas, type TargetId } from "../api/client";
import { SHORT } from "./wording";

type Metric = Schemas["MetricSummary"];
type ModelRow = Schemas["Table1Row"];
type RegionRow = Schemas["Table2Row"];
const PERFORMANCE = [
  ["roc_auc", "ROC AUC", false], ["accuracy", "Accuracy", true], ["precision", "Precision", true],
  ["recall", "Recall", true], ["f1", "F1", true],
] as const;
const CALIBRATION = [["brier", "Brier score"], ["cal_slope", "Calibration slope"],
  ["cal_intercept", "Calibration intercept"]] as const;
const percent = (n: number) => `${(n * 100).toFixed(1)}%`;
const probability = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
const count = (n: unknown): n is number => Number.isInteger(n) && Number(n) >= 0;
const finiteOrNull = (n: unknown) => n === null || (typeof n === "number" && Number.isFinite(n));
const selected = (rows: ModelRow[], target: TargetId) => rows.find((row) =>
  row.target === target && row.kind === "model" && ["nested_cv_selected", "mock_model"].includes(row.model))!;

/** Reject partial or mismatched evaluation payloads before displaying scientific claims. */
function checkEvaluation(data: Evaluation, modelVersion: string, mock: boolean) {
  const invalid = () => { throw new Error("Evaluation data is incomplete or inconsistent. No metrics shown."); };
  if (data.model_version !== modelVersion) {
    throw new Error("Evaluation and active model versions differ. Reload the app before comparing results.");
  }
  if (data.table1_scope !== "outer-fold mean ± SD" || data.table2_scope !== "pooled OOF (prespecified repeat)"
    || !Array.isArray(data.table1) || !Array.isArray(data.table2)) invalid();
  for (const row of data.table1) {
    if (!row || !TARGET_IDS.includes(row.target) || typeof row.model !== "string" || !probability(row.prevalence)
      || !["model", "always_negative", "always_positive", "prior"].includes(row.kind)
      || !row.metrics || typeof row.metrics !== "object" || Array.isArray(row.metrics)) invalid();
    for (const [key, metric] of Object.entries(row.metrics)) {
      if (!metric || !finiteOrNull(metric.mean) || !finiteOrNull(metric.sd)
        || (metric.sd !== null && metric.sd < 0) || !count(metric.n_defined) || !count(metric.n_na)
        || (metric.mean === null ? metric.n_defined !== 0 : metric.n_defined === 0)
        || (["roc_auc", "pr_auc", "accuracy", "precision", "recall", "f1", "brier"].includes(key)
          && metric.mean !== null && !probability(metric.mean))) invalid();
    }
  }
  for (const target of TARGET_IDS) {
    const models = data.table1.filter((row) => row.target === target && row.kind === "model"
      && ["mock_model", "nested_cv_selected"].includes(row.model));
    if (models.length !== 1 || models[0]!.model !== (mock ? "mock_model" : "nested_cv_selected")
      || !PERFORMANCE.every(([key]) => models[0]!.metrics[key])) invalid();
    const regions = data.table2.filter((row) => row?.target === target);
    if (regions.length !== 1) invalid();
    const row = regions[0]!;
    const portions = [row.pct_high_positive, row.pct_high_negative, row.pct_low_confidence];
    if (!portions.every(probability) || Math.abs(portions.reduce((a, b) => a + b, 0) - 1) > 0.001
      || ![row.ppv, row.npv, row.accuracy_high_confidence].every((n) => n === null || probability(n))
      || !count(row.fn_high_negative) || !count(row.fp_high_positive)) invalid();
    for (const interval of [row.ppv_ci, row.npv_ci]) {
      if (interval !== null && (!Array.isArray(interval) || interval.length !== 2
        || !interval.every(probability) || interval[0]! > interval[1]!)) invalid();
    }
  }
  if (data.table2.length !== TARGET_IDS.length) invalid();
  return data;
}

function MetricValue({ metric, asPercent = false }: { metric?: Metric; asPercent?: boolean }) {
  if (!metric) return <span className="text-slate-500">Not supplied</span>;
  const format = (n: number) => asPercent ? percent(n) : n.toFixed(3);
  return <div>
    <span className="whitespace-nowrap font-medium tabular-nums">
      {metric.mean === null ? "NA" : format(metric.mean)}
      {metric.mean !== null && metric.sd !== null && <span className="font-normal text-slate-500">
        {` ± ${asPercent ? (metric.sd * 100).toFixed(1) + " pp" : metric.sd.toFixed(3)}`}
      </span>}
    </span>
    <div className="mt-1 text-[11px] font-normal text-slate-500">
      {metric.n_defined} defined · {metric.n_na} undefined folds
    </div>
  </div>;
}

function modelName(row: ModelRow) {
  if (row.kind === "always_negative") return "Always negative";
  if (row.kind === "always_positive") return "Always positive";
  if (row.kind === "prior") return "Prevalence-only baseline";
  if (row.model === "mock_model") return "Selected model (synthetic)";
  if (row.model === "nested_cv_selected") return "Selected model";
  return row.model.replace(/^benchmark_/, "Benchmark: ");
}

function RegionEstimate({ value, interval }: { value: number | null; interval: number[] | null }) {
  return <>
    <span className="font-semibold tabular-nums">{value === null ? "NA" : percent(value)}</span>
    <span className="mt-1 block text-xs text-slate-500">
      {value === null ? "No defined estimate" : interval ? `95% CI ${percent(interval[0]!)}–${percent(interval[1]!)}` : "CI not supplied"}
    </span>
  </>;
}

function Coverage({ row }: { row: RegionRow }) {
  const regions = [
    { label: "High positive", value: row.pct_high_positive, color: "bg-amber-500", dot: "bg-amber-500" },
    { label: "High negative", value: row.pct_high_negative, color: "bg-sky-600", dot: "bg-sky-600" },
    { label: "Low confidence", value: row.pct_low_confidence, color: "bg-slate-300", dot: "bg-slate-300" },
  ];
  return <div>
    <div aria-hidden="true" className="my-3 flex h-3 overflow-hidden rounded-full bg-slate-100">
      {regions.map((region) => <span key={region.label} className={region.color} style={{ width: percent(region.value) }} />)}
    </div>
    <dl className="space-y-2 text-sm">
      {regions.map((region) => <div key={region.label} className="flex items-center justify-between gap-3">
        <dt className="flex items-center gap-2 text-slate-600"><span aria-hidden="true" className={`h-2 w-2 rounded-full ${region.dot}`} />{region.label}</dt>
        <dd className="font-semibold tabular-nums">{percent(region.value)}</dd>
      </div>)}
    </dl>
  </div>;
}

export function EvaluationPanel({ meta, metaMock }: { meta: Meta; metaMock: boolean }) {
  const [target, setTarget] = useState<TargetId>("cad");
  const evaluation = useQuery({
    queryKey: ["evaluation", meta.model_version, metaMock],
    queryFn: async ({ signal }) => {
      const result = await api.evaluation(signal);
      const mock = result.mock || metaMock || result.data.model_version === "0.0.0";
      return { ...result, mock, data: checkEvaluation(result.data, meta.model_version, mock) };
    },
    staleTime: Infinity,
    retry: false,
  });
  // Hide cached metrics during refresh or after an error, so stale values cannot look current.
  const result = !evaluation.isFetching && !evaluation.isError ? evaluation.data : undefined;
  const data = result?.data;
  const region = data?.table2.find((row) => row.target === target);
  const targetSpec = meta.targets.find((spec) => spec.id === target);
  const card = "rounded-lg border border-slate-200 bg-white p-4";

  return <main aria-label="Model evaluation" className="min-h-0 flex-1 overflow-auto p-3 sm:p-5">
    <div className="mx-auto max-w-7xl space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h1 className="text-xl font-semibold tracking-tight">Model evaluation</h1>
          <p className="mt-1 text-sm text-slate-600">How well the model estimates the dataset labels, and where evidence is limited.</p></div>
        <button type="button" onClick={() => void evaluation.refetch()} disabled={evaluation.isFetching}
          className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-50">
          {evaluation.isFetching ? "Loading…" : evaluation.isError ? "Retry evaluation" : "Refresh evaluation"}
        </button>
      </div>
      {(metaMock || result?.mock) && <div role="note" data-testid="evaluation-mock" className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
        <strong className="block">SYNTHETIC DEMO METRICS · NOT MODEL PERFORMANCE</strong>
        <p className="mt-1">These values test the interface only, including the baseline rows. Trained artifacts are required to display measured performance.</p>
      </div>}
      {evaluation.isFetching && <p role="status" className={`${card} text-sm text-slate-600`}>Loading evaluation from the API…</p>}
      {evaluation.isError && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-900">
        <strong>Evaluation unavailable. No metrics shown.</strong>
        <p className="mt-1">{evaluation.error.message}</p>
      </div>}
      {data && <>
        <div className="flex flex-wrap gap-x-6 gap-y-2 text-xs text-slate-600">
          <span>Model version <strong>{data.model_version}</strong></span>
          <span>Performance: {data.table1_scope}</span><span>Confidence regions: {data.table2_scope}</span>
        </div>
        <section aria-labelledby="target-overview-title">
          <h2 id="target-overview-title" className="mb-3 text-sm font-semibold">Four independent targets</h2>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {TARGET_IDS.map((id) => <button key={id} type="button" aria-pressed={target === id} data-testid={`evaluation-target-${id}`}
              onClick={() => setTarget(id)} className={`${card} text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600 ${target === id ? "border-slate-800 ring-1 ring-slate-800" : "hover:border-slate-400"}`}>
              <span className="flex items-center justify-between gap-2"><span className="text-sm font-semibold">{SHORT[id]}</span>
                <span className="text-xs text-slate-500">{target === id ? "Selected" : "View details"}</span></span>
              <span className="mb-2 mt-1 block text-xs text-slate-500">{id === "cad" ? "Dataset CAD label" : `≥50% ${SHORT[id]} stenosis label`}</span>
              <span className="mb-1 block text-xs text-slate-600">ROC AUC</span>
              <MetricValue metric={selected(data.table1, id).metrics.roc_auc} />
            </button>)}
          </div>
        </section>
        <section className={card} aria-labelledby="performance-title">
          <h2 id="performance-title" className="font-semibold">Selected-model performance</h2>
          <p className="mb-3 mt-1 text-xs text-slate-500">Mean ± standard deviation across outer folds. SD describes variation across folds; it is not a confidence interval. Percentage SD is in percentage points (pp).</p>
          <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Performance table, scroll horizontally on small screens">
            <table className="w-full text-left text-sm" data-testid="evaluation-performance">
              <caption className="sr-only">Selected-model metrics for all four targets</caption>
              <thead><tr className="border-b border-slate-200 text-xs text-slate-500"><th scope="col" className="p-3 pl-0">Target</th>
                {PERFORMANCE.map(([key, label]) => <th key={key} scope="col" className="p-3 font-medium">{label}</th>)}</tr></thead>
              <tbody>{TARGET_IDS.map((id) => <tr key={id} className="border-b border-slate-100 last:border-0">
                <th scope="row" className="p-3 pl-0">{SHORT[id]}</th>
                {PERFORMANCE.map(([key, , asPercent]) => <td key={key} className="p-3"><MetricValue metric={selected(data.table1, id).metrics[key]} asPercent={asPercent} /></td>)}
              </tr>)}</tbody>
            </table>
          </div>
        </section>
        <section className={card} aria-labelledby="comparison-title">
          <h2 id="comparison-title" className="font-semibold">{SHORT[target]} · Baselines and benchmarks</h2>
          <p className="mb-3 mt-1 text-xs text-slate-500">{targetSpec?.label_definition} · Label prevalence {percent(selected(data.table1, target).prevalence)}. NA means undefined; it does not mean zero.</p>
          <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Baseline comparison table, scroll horizontally on small screens">
            <table className="w-full text-left text-sm" data-testid="evaluation-baselines">
              <caption className="sr-only">{SHORT[target]} comparison with simple baselines and supplied benchmarks</caption>
              <thead><tr className="border-b border-slate-200 text-xs text-slate-500"><th scope="col" className="p-3 pl-0">Model / baseline</th>
                {PERFORMANCE.map(([key, label]) => <th key={key} scope="col" className="p-3 font-medium">{label}</th>)}</tr></thead>
              <tbody>{data.table1.filter((row) => row.target === target).map((row) => <tr key={`${row.kind}-${row.model}`} className="border-b border-slate-100 last:border-0">
                <th scope="row" className="p-3 pl-0 font-medium">{modelName(row)}</th>
                {PERFORMANCE.map(([key, , asPercent]) => <td key={key} className="p-3"><MetricValue metric={row.metrics[key]} asPercent={asPercent} /></td>)}
              </tr>)}</tbody>
            </table>
          </div>
        </section>
        {region && <section className="grid gap-3 lg:grid-cols-[1fr_2fr]" aria-labelledby="confidence-title">
          <div className={card}><h2 id="confidence-title" className="font-semibold">{SHORT[target]} · Confidence coverage</h2>
            <p className="mt-1 text-xs text-slate-500">Pooled out-of-fold (OOF) cases in each threshold region.</p><Coverage row={region} />
          </div>
          <div className={card}>
            <div className="grid gap-4 sm:grid-cols-3">
              <div><h3 className="mb-2 text-xs text-slate-600">Positive predictive value<br />(high-positive region)</h3><RegionEstimate value={region.ppv} interval={region.ppv_ci} /></div>
              <div><h3 className="mb-2 text-xs text-slate-600">Negative predictive value<br />(high-negative region)</h3><RegionEstimate value={region.npv} interval={region.npv_ci} /></div>
              <div><h3 className="mb-2 text-xs text-slate-600">Accuracy within<br />high-confidence regions</h3><span className="font-semibold tabular-nums">{region.accuracy_high_confidence === null ? "NA" : percent(region.accuracy_high_confidence)}</span></div>
            </div>
            <p className="mt-4 text-sm text-slate-700">Errors within these regions: <strong>{region.fn_high_negative}</strong> false negatives in high negative; <strong>{region.fp_high_positive}</strong> false positives in high positive.</p>
            <p className="mt-3 rounded bg-slate-50 p-3 text-xs leading-relaxed text-slate-600">This table applies thresholds only, before the app’s input-quality and stability gates. A patient’s displayed confidence can therefore be lower. These figures do not establish clinical safety or external validity. Region sample counts are not supplied by this API.</p>
          </div>
        </section>}
        <section className={card} aria-labelledby="calibration-title">
          <h2 id="calibration-title" className="font-semibold">{SHORT[target]} · Calibration</h2>
          <div className="my-3 grid gap-4 sm:grid-cols-3">{CALIBRATION.map(([key, label]) => <div key={key}>
            <h3 className="mb-2 text-xs text-slate-600">{label}</h3><MetricValue metric={selected(data.table1, target).metrics[key]} />
          </div>)}</div>
          <p className="text-xs leading-relaxed text-slate-500">Brier score measures probability error (lower is better). A calibration slope near 1 and intercept near 0 are desirable. Reliability curves require saved fold predictions and are not supplied in this view.</p>
        </section>
        <aside className="rounded-lg border border-slate-200 bg-slate-100 p-4 text-sm leading-relaxed text-slate-600" aria-label="Evaluation limits">
          <strong className="text-slate-800">Read these results within their limits.</strong> These are internal dataset-label estimates, not a clinically validated cardiac-risk score. Fold counts describe defined metric estimates, not patient counts. Values alone do not demonstrate a significant improvement over baselines. Vessel predictions do not locate lesions.
        </aside>
      </>}
    </div>
  </main>;
}
