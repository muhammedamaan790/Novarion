// Curves (plan §7): ROC, precision–recall, reliability and the threshold sweep, pooled out-of-fold (prespecified repeat)
// with patient-level bootstrap bands. Only what the evaluation computed is drawn: no operating point on the ROC (no
// pooled one exists), no average precision (only the outer-fold PR-AUC is computed), suppressed sweep points stay hidden.
import type { ReactNode } from "react";
import {
  Area, CartesianGrid, ComposedChart, ErrorBar, Line, LineChart, ReferenceLine, Scatter, ScatterChart, XAxis, YAxis,
} from "recharts";
import type { Schemas, TargetId } from "../../api/client";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, type ChartConfig } from "../ui/chart";
import { SHORT } from "../wording";
import { C, Card, ExportButtons, InfoTip, N_FOLDS, Unavailable, f2, f3, pct1 } from "./kit";

interface Curve { fpr?: number[]; tpr?: number[]; recall?: number[]; precision?: number[]; lo: (number | null)[]; hi: (number | null)[]; prevalence?: number }
interface SweepPoint { t: number; ppv: number | null; npv: number | null; coverage_above: number; n_above?: number; n_below?: number }
export interface Figures {
  scope?: string;
  roc?: Curve;
  pr?: Curve;
  valid_replicates?: number;
  reliability?: { mean_predicted: number; observed_rate: number; n: number; lo: number | null; hi: number | null }[];
  threshold_sweep?: SweepPoint[];
  deployed_thresholds?: { t_op: number; t_neg: number | null; t_pos: number | null } | null;
  selected_families?: Record<string, number>;
  calibration_guard_events?: number;
  table2_auc?: number | null;
  table2_auc_ci?: number[] | null;
}
type Metric = Schemas["MetricSummary"] | null;

const N_MIN = 15; // same minimum as a qualifying confidence region (targets.yaml n_min_region)
const TICKS = [0, 0.25, 0.5, 0.75, 1];
const pct0 = (v: number) => `${Math.round(v * 100)}%`;
const AXIS = "fill-slate-600 text-[11px]";
const H = "aspect-auto h-[270px] w-full sm:h-[300px]";

function Tip({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-w-[10rem] gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs shadow-xl tabular-nums">
      {children}
    </div>
  );
}
function TipRow({ label, value, color, dash }: { label: string; value: ReactNode; color?: string; dash?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="flex items-center gap-1.5 text-slate-600">
        {color && <span className="inline-block h-0.5 w-3" style={{ background: dash ? `repeating-linear-gradient(90deg, ${color} 0 3px, transparent 3px 5px)` : color }} />}
        {label}
      </span>
      <span className="font-semibold text-slate-900">{value}</span>
    </div>
  );
}
type TipProps = { active?: boolean; payload?: readonly { payload?: unknown }[] };
const first = (p: TipProps) => (p.active && p.payload?.length ? (p.payload[0]!.payload as Record<string, unknown>) : null);

const rocConfig = { y: { label: "ROC", color: C.primary } } satisfies ChartConfig;

function Roc({ f, target }: { f: Figures; target: TargetId }) {
  const roc = f.roc!;
  const data = roc.fpr!.map((x, i) => ({ x, y: roc.tpr![i]!, lo: roc.lo[i] ?? null, hi: roc.hi[i] ?? null,
    band: roc.lo[i] != null && roc.hi[i] != null ? [roc.lo[i]!, roc.hi[i]!] : null }));
  return (
    <Card title={`ROC · ${SHORT[target]}`} testId="curve-roc"
          info="Each point is a threshold: the share of positives caught (true-positive rate) against the share of negatives wrongly flagged (false-positive rate). The dashed diagonal is chance."
          subtitle={<>{f.scope}{f.table2_auc != null && <> · <b>AUC {f3(f.table2_auc)}</b></>}
            {f.table2_auc_ci && ` [95% CI ${f3(f.table2_auc_ci[0]!)}–${f3(f.table2_auc_ci[1]!)}]`}
            {f.valid_replicates != null && ` · ${f.valid_replicates} bootstrap replicates`}</>}
          actions={<ExportButtons name={`roc-${target}`} meta={{ scope: f.scope, auc: f.table2_auc, auc_ci95: f.table2_auc_ci }}
                                  rows={data.map((d) => ({ fpr: d.x, tpr: d.y, tpr_ci_low: d.lo, tpr_ci_high: d.hi }))} />}>
      <ChartContainer config={rocConfig} className={H}>
        <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 8, left: 0 }} accessibilityLayer>
          <CartesianGrid strokeDasharray="0" />
          <XAxis type="number" dataKey="x" domain={[0, 1]} ticks={TICKS} tickFormatter={pct0} height={42}
                 label={{ value: "False-positive rate (1 − specificity)", position: "insideBottom", offset: 0, className: AXIS }} />
          <YAxis type="number" domain={[0, 1]} ticks={TICKS} tickFormatter={pct0} width={52}
                 label={{ value: "True-positive rate", angle: -90, position: "insideLeft", offset: 10, className: AXIS, style: { textAnchor: "middle" } }} />
          <ReferenceLine segment={[{ x: 0, y: 0 }, { x: 1, y: 1 }]} stroke="#64748b" strokeDasharray="4 4" />
          <Area dataKey="band" stroke="none" fill="var(--color-y)" fillOpacity={0.16} isAnimationActive={false} connectNulls />
          <Line dataKey="y" stroke="var(--color-y)" strokeWidth={2.5} dot={false} isAnimationActive={false} type="linear" />
          <ChartTooltip content={(p: TipProps) => {
            const d = first(p);
            return d ? (
              <Tip>
                <TipRow label="False-positive rate" value={pct1(d.x as number)} />
                <TipRow label="True-positive rate" value={pct1(d.y as number)} color={C.primary} />
                <TipRow label="95% band" value={d.lo != null ? `${pct1(d.lo as number)}–${pct1(d.hi as number)}` : "—"} />
              </Tip>
            ) : null;
          }} />
        </ComposedChart>
      </ChartContainer>
      <p className="mt-1 text-xs text-slate-600">
        Shaded: bootstrap 95% band of the true-positive rate. Dashed diagonal: chance (AUC 0.5). The fold-level operating point is not drawn: no pooled
        sensitivity/specificity at t_op is computed (see Performance for the outer-fold values).
      </p>
    </Card>
  );
}

const prConfig = { y: { label: "Precision", color: C.primary } } satisfies ChartConfig;

function Pr({ f, target, prAuc }: { f: Figures; target: TargetId; prAuc: Metric }) {
  const pr = f.pr!;
  const data = pr.recall!.map((x, i) => ({ x, y: pr.precision![i]!, lo: pr.lo[i] ?? null, hi: pr.hi[i] ?? null,
    band: pr.lo[i] != null && pr.hi[i] != null ? [pr.lo[i]!, pr.hi[i]!] : null }));
  const prev = pr.prevalence;
  return (
    <Card title={`Precision–recall · ${SHORT[target]}`} testId="curve-pr"
          info="Precision (PPV) against recall (sensitivity) across thresholds. A model with no skill sits on the prevalence line, not on 0.5, so the baseline depends on how common the label is."
          subtitle={<>{f.scope}{prAuc?.mean != null && <> · PR-AUC {f3(prAuc.mean)}{prAuc.sd != null && ` ± ${f3(prAuc.sd)}`} (outer-fold mean ± SD, {N_FOLDS} folds; average precision is not computed)</>}</>}
          actions={<ExportButtons name={`pr-${target}`} meta={{ scope: f.scope, prevalence: prev }}
                                  rows={data.map((d) => ({ recall: d.x, precision: d.y, precision_ci_low: d.lo, precision_ci_high: d.hi }))} />}>
      <ChartContainer config={prConfig} className={H}>
        <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 8, left: 0 }} accessibilityLayer>
          <CartesianGrid />
          <XAxis type="number" dataKey="x" domain={[0, 1]} ticks={TICKS} tickFormatter={pct0} height={42}
                 label={{ value: "Recall (sensitivity)", position: "insideBottom", offset: 0, className: AXIS }} />
          <YAxis type="number" domain={[0, 1]} ticks={TICKS} tickFormatter={pct0} width={52}
                 label={{ value: "Precision (PPV)", angle: -90, position: "insideLeft", offset: 10, className: AXIS, style: { textAnchor: "middle" } }} />
          {prev != null && (
            <ReferenceLine y={prev} stroke="#64748b" strokeDasharray="4 4"
                           label={{ value: `no-skill baseline = prevalence ${pct1(prev)}`, position: "insideBottomLeft", className: "fill-slate-600 text-[10px]" }} />
          )}
          <Area dataKey="band" stroke="none" fill="var(--color-y)" fillOpacity={0.16} isAnimationActive={false} connectNulls />
          <Line dataKey="y" stroke="var(--color-y)" strokeWidth={2.5} dot={false} isAnimationActive={false} type="linear" />
          <ChartTooltip content={(p: TipProps) => {
            const d = first(p);
            return d ? (
              <Tip>
                <TipRow label="Recall" value={pct1(d.x as number)} />
                <TipRow label="Precision" value={pct1(d.y as number)} color={C.primary} />
                <TipRow label="95% band" value={d.lo != null ? `${pct1(d.lo as number)}–${pct1(d.hi as number)}` : "—"} />
              </Tip>
            ) : null;
          }} />
        </ComposedChart>
      </ChartContainer>
      <p className="mt-1 text-xs text-slate-600">Shaded: bootstrap 95% band of precision. Dashed: the prevalence, what a model with no skill would achieve.</p>
    </Card>
  );
}

const relConfig = { y: { label: "Observed", color: C.primary } } satisfies ChartConfig;

function Reliability({ f, target, calSlope, calIntercept }: { f: Figures; target: TargetId; calSlope: Metric; calIntercept: Metric }) {
  const bins = f.reliability!;
  const data = bins.map((b) => ({ x: b.mean_predicted, y: b.observed_rate, n: b.n, lo: b.lo, hi: b.hi,
    err: b.lo != null && b.hi != null ? [Math.max(0, b.observed_rate - b.lo), Math.max(0, b.hi - b.observed_rate)] : undefined }));
  return (
    <Card title={`Reliability · ${SHORT[target]}`} testId="curve-reliability"
          info="Calibration: within each bin of predicted probability, how often the label was actually positive. Points on the diagonal mean the probabilities can be read at face value."
          subtitle={<>pooled OOF · {bins.length} quantile bins · bars = bootstrap 95% CI of the observed rate
            {calSlope?.mean != null && <> · calibration slope {f2(calSlope.mean)}{calSlope.sd != null && ` ± ${f2(calSlope.sd)}`}</>}
            {calIntercept?.mean != null && <>, intercept {f2(calIntercept.mean)}{calIntercept.sd != null && ` ± ${f2(calIntercept.sd)}`}</>}
            {(calSlope?.mean != null || calIntercept?.mean != null) && ` (outer-fold mean ± SD)`}</>}
          actions={<ExportButtons name={`reliability-${target}`} meta={{ scope: "pooled OOF, quantile bins, bootstrap 95% CI" }}
                                  rows={bins.map((b) => ({ ...b }))} />}>
      <ChartContainer config={relConfig} className={H}>
        <ScatterChart margin={{ top: 8, right: 16, bottom: 8, left: 0 }} accessibilityLayer>
          <CartesianGrid />
          <XAxis type="number" dataKey="x" domain={[0, 1]} ticks={TICKS} tickFormatter={pct0} height={42}
                 label={{ value: "Mean predicted probability", position: "insideBottom", offset: 0, className: AXIS }} />
          <YAxis type="number" dataKey="y" domain={[0, 1]} ticks={TICKS} tickFormatter={pct0} width={52}
                 label={{ value: "Observed positive rate", angle: -90, position: "insideLeft", offset: 10, className: AXIS, style: { textAnchor: "middle" } }} />
          <ReferenceLine segment={[{ x: 0, y: 0 }, { x: 1, y: 1 }]} stroke="#64748b" strokeDasharray="4 4" />
          <Scatter data={data} fill="var(--color-y)" isAnimationActive={false}
                   shape={(p: unknown) => {
                     const { cx, cy } = p as { cx?: number; cy?: number };
                     return cx == null || cy == null ? <g /> : <circle cx={cx} cy={cy} r={5.5} fill={C.primary} stroke="#fff" strokeWidth={2} />;
                   }}>
            <ErrorBar dataKey="err" direction="y" width={6} strokeWidth={2} stroke={C.primary} />
          </Scatter>
          <ChartTooltip cursor={false} content={(p: TipProps) => {
            const d = first(p);
            return d ? (
              <Tip>
                <TipRow label="Mean predicted" value={pct1(d.x as number)} />
                <TipRow label="Observed rate" value={pct1(d.y as number)} color={C.primary} />
                <TipRow label="95% CI" value={d.lo != null ? `${pct1(d.lo as number)}–${pct1(d.hi as number)}` : "not computed"} />
                <TipRow label="Patients in bin" value={d.n as number} />
              </Tip>
            ) : null;
          }} />
        </ScatterChart>
      </ChartContainer>
      <p className="mt-1 text-xs text-slate-600">Dashed diagonal: ideal calibration (observed = predicted).</p>
      <div className="-mx-4 mt-2 overflow-x-auto px-4">
        <table className="w-full min-w-[24rem] text-xs tabular-nums" data-testid="reliability-bins">
          <thead className="font-bold uppercase tracking-wide text-slate-600">
            <tr className="border-b border-slate-200">
              <th scope="col" className="py-1.5 pr-2 text-left">Bin</th>
              <th scope="col" className="px-2 text-right">Patients</th>
              <th scope="col" className="px-2 text-right">Mean predicted</th>
              <th scope="col" className="px-2 text-right">Observed rate</th>
              <th scope="col" className="pl-2 text-right">95% CI</th>
            </tr>
          </thead>
          <tbody className="text-slate-800">
            {bins.map((b, i) => (
              <tr key={i} className="border-t border-slate-100">
                <th scope="row" className="py-1 pr-2 text-left font-medium">{i + 1}</th>
                <td className="px-2 text-right">{b.n}</td>
                <td className="px-2 text-right">{pct1(b.mean_predicted)}</td>
                <td className="px-2 text-right font-semibold">{pct1(b.observed_rate)}</td>
                <td className="pl-2 text-right">{b.lo != null && b.hi != null ? `${pct1(b.lo)}–${pct1(b.hi)}` : <Unavailable>not computed</Unavailable>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

const sweepConfig = {
  ppv: { label: "PPV of p ≥ t", color: C.primary },
  npv: { label: "NPV of p < t", color: C.second },
  cov: { label: "Coverage: share with p ≥ t", color: C.third },
} satisfies ChartConfig;

/** A threshold label with a white backing, stacked by `row` so coinciding or nearby thresholds never overlap. */
function ThresholdLabel({ viewBox, text, row }: { viewBox?: { x?: number; y?: number }; text: string; row: number }) {
  const x = viewBox?.x ?? 0;
  const y = (viewBox?.y ?? 0) + 4 + row * 15;
  const w = text.length * 6.3 + 10;
  return (
    <g>
      <rect x={x + 3} y={y} width={w} height={13} rx={2} fill="#ffffff" stroke="#0f172a" strokeWidth={0.75} />
      <text x={x + 7} y={y + 9.5} className="fill-slate-900 text-[10px] font-semibold">{text}</text>
    </g>
  );
}

function Sweep({ f, target }: { f: Figures; target: TargetId }) {
  const sweep = f.threshold_sweep ?? [];
  const thr = f.deployed_thresholds;
  const masked = (v: number | null, n: number | undefined) => (n != null && n < N_MIN ? null : v);
  const data = sweep.map((s) => ({ t: s.t, ppv: masked(s.ppv, s.n_above), npv: masked(s.npv, s.n_below), cov: s.coverage_above,
    n_above: s.n_above ?? null, n_below: s.n_below ?? null,
    ppvSuppressed: s.ppv != null && s.n_above != null && s.n_above < N_MIN, npvSuppressed: s.npv != null && s.n_below != null && s.n_below < N_MIN }));
  // Deployed thresholds, merged where they coincide (CAD: t_op = t_pos) so one line carries both names.
  const marks: { x: number; names: string[] }[] = [];
  if (thr) {
    for (const [name, x] of [["t_op", thr.t_op], ["t_pos", thr.t_pos], ["t_neg", thr.t_neg]] as const) {
      if (x == null) continue;
      const same = marks.find((m) => Math.abs(m.x - x) < 1e-9);
      if (same) same.names.push(name); else marks.push({ x, names: [name] });
    }
  }
  const ppvHiddenFrom = data.find((d) => d.n_above != null && d.n_above < N_MIN)?.t;
  const npvHiddenTo = [...data].reverse().find((d) => d.n_below != null && d.n_below < N_MIN)?.t;
  return (
    <Card title={`Threshold sweep · ${SHORT[target]}`} testId="curve-sweep"
          info="How the measured PPV, NPV and coverage change if the score were cut at threshold t. PPV is measured among patients with p ≥ t, NPV among p < t, and coverage is the share of all patients with p ≥ t."
          subtitle={`pooled OOF · measured PPV of p ≥ t and NPV of p < t (hidden where n < ${N_MIN}), coverage of p ≥ t · deployed thresholds marked`}
          actions={<ExportButtons name={`threshold-sweep-${target}`} meta={{ scope: "pooled OOF", n_min_shown: N_MIN, deployed_thresholds: thr }}
                                  rows={data.map((d) => ({ t: d.t, ppv_shown: d.ppv, ppv_suppressed: d.ppvSuppressed, n_above: d.n_above,
                                    npv_shown: d.npv, npv_suppressed: d.npvSuppressed, n_below: d.n_below, coverage_above: d.cov }))} />}>
      <ChartContainer config={sweepConfig} className="aspect-auto h-[300px] w-full sm:h-[330px]">
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }} accessibilityLayer>
          <CartesianGrid />
          <XAxis type="number" dataKey="t" domain={[0, 1]} ticks={[0, 0.2, 0.4, 0.6, 0.8, 1]} tickFormatter={f2} height={42}
                 label={{ value: "Threshold t (predicted probability)", position: "insideBottom", offset: 0, className: AXIS }} />
          <YAxis domain={[0, 1]} ticks={TICKS} tickFormatter={pct0} width={52}
                 label={{ value: "Rate", angle: -90, position: "insideLeft", offset: 10, className: AXIS, style: { textAnchor: "middle" } }} />
          {marks.map((m, i) => (
            <ReferenceLine key={m.names.join()} x={m.x} stroke="#0f172a" strokeWidth={1.5}
                           label={<ThresholdLabel text={`${m.names.join(" = ")} ${f3(m.x)}`} row={i} />} />
          ))}
          <Line dataKey="ppv" stroke="var(--color-ppv)" strokeWidth={2.5} dot={false} isAnimationActive={false} connectNulls={false} />
          <Line dataKey="npv" stroke="var(--color-npv)" strokeWidth={2.5} strokeDasharray="9 3" dot={false} isAnimationActive={false} connectNulls={false} />
          <Line dataKey="cov" stroke="var(--color-cov)" strokeWidth={2} strokeDasharray="2 3" dot={false} isAnimationActive={false} />
          <ChartLegend content={<ChartLegendContent />} itemSorter={(i) => ["ppv", "npv", "cov"].indexOf(String(i.dataKey))} />
          <ChartTooltip content={(p: TipProps) => {
            const d = first(p);
            if (!d) return null;
            const sup = (n: unknown) => <Unavailable>suppressed: n = {String(n)} &lt; {N_MIN}</Unavailable>;
            return (
              <Tip>
                <div className="font-semibold text-slate-900">t = {f3(d.t as number)} <span className="font-normal text-slate-500">(exploratory)</span></div>
                <TipRow label={`PPV (n = ${d.n_above ?? "?"})`} color={C.primary}
                        value={d.ppvSuppressed ? sup(d.n_above) : d.ppv == null ? "—" : pct1(d.ppv as number)} />
                <TipRow label={`NPV (n = ${d.n_below ?? "?"})`} color={C.second} dash
                        value={d.npvSuppressed ? sup(d.n_below) : d.npv == null ? "—" : pct1(d.npv as number)} />
                <TipRow label="Coverage" color={C.third} dash value={pct1(d.cov as number)} />
              </Tip>
            );
          }} />
        </LineChart>
      </ChartContainer>
      <dl className="mt-3 grid gap-x-6 gap-y-1.5 text-xs text-slate-700 md:grid-cols-3" data-testid="threshold-key">
        <div>
          <dt className="font-semibold text-slate-900">t_op = {thr ? f3(thr.t_op) : "—"} <span className="font-normal text-slate-500">(deployed, solid line)</span></dt>
          <dd>Operating threshold: every patient gets a binary call, positive when p ≥ t_op (Youden&apos;s J on training-side out-of-fold probabilities).</dd>
        </div>
        <div>
          <dt className="font-semibold text-slate-900">t_pos = {thr?.t_pos != null ? f3(thr.t_pos) : "none"}</dt>
          <dd>{thr?.t_pos != null ? "Lower edge of the qualified-positive region: p ≥ t_pos can be shown with high support, if no display gate applies."
            : "No score range met the pre-registered PPV ≥ 90% target, so there is no qualified-positive region."}</dd>
        </div>
        <div>
          <dt className="font-semibold text-slate-900">t_neg = {thr?.t_neg != null ? f3(thr.t_neg) : "none"}</dt>
          <dd>{thr?.t_neg != null ? "Upper edge of the qualified-negative region: p < t_neg can be shown with high support."
            : "No score range met the pre-registered NPV ≥ 95% target, so there is no qualified-negative region."}</dd>
        </div>
      </dl>
      <p className="mt-2 text-xs text-slate-600" data-testid="sweep-suppression">
        <b>PPV vs NPV vs coverage:</b> PPV answers &quot;of those above t, how many are positive?&quot;, NPV &quot;of those below
        t, how many are negative?&quot;, coverage &quot;how many are above t at all?&quot;. Suppressed where fewer than {N_MIN} patients
        are measured
        {ppvHiddenFrom != null && <>: PPV hidden from t = {f2(ppvHiddenFrom)}</>}
        {npvHiddenTo != null && <>{ppvHiddenFrom != null ? ";" : ":"} NPV hidden up to t = {f2(npvHiddenTo)}</>}
        . Hover a point for its sample size; the hover line is exploratory, only the solid lines are deployed.
      </p>
    </Card>
  );
}

export function Curves({ figures, target, prAuc, calSlope, calIntercept }: {
  figures: Figures; target: TargetId; prAuc: Metric; calSlope: Metric; calIntercept: Metric;
}) {
  if (!figures.roc || !figures.pr || !figures.reliability) {
    return <p className="text-sm text-slate-500">Figures are not available for this bundle.</p>;
  }
  return (
    <div className="grid gap-4 lg:grid-cols-2" data-testid="evidence-figures">
      <Roc f={figures} target={target} />
      <Pr f={figures} target={target} prAuc={prAuc} />
      <Reliability f={figures} target={target} calSlope={calSlope} calIntercept={calIntercept} />
      <Sweep f={figures} target={target} />
      <p className="text-xs text-slate-600 lg:col-span-2">
        All four curves use the pooled out-of-fold predictions of the prespecified repeat (each patient once), so they
        differ slightly from the outer-fold means in Performance.<InfoTip text="Outer-fold means average 25 per-fold values; pooled curves score all 303 out-of-fold predictions together. Both are internal validation." />
      </p>
    </div>
  );
}
