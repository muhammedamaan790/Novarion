// Model Center charts (D-037), drawn with the same parts as the Model Evidence page (shadcn chart + Recharts, the
// evidence kit's card, export and dot-and-interval chart) so both pages read the same way. Only stored numbers are
// drawn: the replay's per-size mean and min–max over seeds, the gate counts, and the gate report's paired ΔAUC CIs.
import type { ReactNode } from "react";
import { Area, Bar, BarChart, CartesianGrid, ComposedChart, LabelList, Line, ReferenceLine, XAxis, YAxis } from "recharts";
import { TARGET_IDS, type Schemas, type TargetId } from "../../api/client";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, type ChartConfig } from "../ui/chart";
import { SHORT } from "../wording";
import { C, Card, DotIntervalChart, ExportButtons, Unavailable, f2, f3, signed3 } from "../evidence/kit";

const AXIS = "fill-slate-600 text-[11px]";
type TipProps = { active?: boolean; payload?: readonly { payload?: unknown }[] };
const first = (p: TipProps) => (p.active && p.payload?.length ? (p.payload[0]!.payload as Record<string, unknown>) : null);

function Tip({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-w-[10rem] gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs shadow-xl tabular-nums">
      {children}
    </div>
  );
}
function TipRow({ label, value, color }: { label: string; value: ReactNode; color?: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="flex items-center gap-1.5 text-slate-600">
        {color && <span className="inline-block h-2 w-2 rounded-sm" style={{ background: color }} />}
        {label}
      </span>
      <span className="font-semibold text-slate-900">{value}</span>
    </div>
  );
}

const curveConfig = { mean: { label: "Mean AUC", color: C.primary } } satisfies ChartConfig;

function LearningCurve({ target, points, yMin, batch, seeds }: {
  target: TargetId; points: Schemas["ReplayPoint"][]; yMin: number; batch: number; seeds: number;
}) {
  const data = points.map((p) => ({ n: p.training_size, mean: p.auc_mean, lo: p.auc_min, hi: p.auc_max, band: [p.auc_min, p.auc_max],
    sd: p.auc_sd, brier: p.brier_mean, seeds: p.n_seeds }));
  const sizes = data.map((d) => d.n);
  const yTicks = Array.from({ length: Math.round((1 - yMin) / 0.1) + 1 }, (_, i) => Math.round((yMin + i * 0.1) * 10) / 10);
  const lastMean = data.at(-1)?.mean;
  const firstMean = data[0]?.mean;
  return (
    <div className="min-w-0 rounded-md border border-slate-100 p-2" data-testid={`learning-curve-${target}`}
         role="img" aria-label={`Learning curve for ${SHORT[target]}: mean forward-holdout AUC ${data.map((d) => `${f3(d.mean)} at ${d.n} patients`).join(", ")}`}>
      <div className="flex items-baseline justify-between gap-2 px-1">
        <h3 className="text-sm font-bold text-slate-900">{SHORT[target]}</h3>
        {firstMean != null && lastMean != null && (
          <span className="text-xs tabular-nums text-slate-600">
            AUC {f3(firstMean)} → <b className="text-slate-900">{f3(lastMean)}</b>
          </span>
        )}
      </div>
      <ChartContainer config={curveConfig} className="aspect-auto h-[200px] w-full">
        <ComposedChart data={data} margin={{ top: 8, right: 14, bottom: 4, left: 0 }} accessibilityLayer={false}>
          <CartesianGrid />
          <XAxis type="number" dataKey="n" domain={[sizes[0] ?? 0, sizes.at(-1) ?? 1]} ticks={sizes} height={36}
                 label={{ value: "Training size (patients)", position: "insideBottom", offset: 0, className: AXIS }} />
          <YAxis type="number" domain={[yMin, 1]} ticks={yTicks} tickFormatter={f2} width={40} />
          <ReferenceLine y={0.5} stroke="#64748b" strokeDasharray="4 4"
                         label={{ value: "chance", position: "insideBottomRight", className: "fill-slate-500 text-[10px]" }} />
          <Area dataKey="band" stroke="none" fill="var(--color-mean)" fillOpacity={0.16} isAnimationActive={false} />
          <Line dataKey="mean" stroke="var(--color-mean)" strokeWidth={2.5} isAnimationActive={false} type="linear"
                dot={{ r: 4, fill: C.primary, stroke: "#fff", strokeWidth: 2 }} activeDot={{ r: 5.5 }} />
          <ChartTooltip content={(p: TipProps) => {
            const d = first(p);
            return d ? (
              <Tip>
                <div className="font-semibold text-slate-900">{d.n as number} training patients</div>
                <TipRow label="Mean AUC" value={f3(d.mean as number)} color={C.primary} />
                <TipRow label="Min–max over orders" value={`${f3(d.lo as number)}–${f3(d.hi as number)}`} />
                <TipRow label="SD" value={f3(d.sd as number)} />
                <TipRow label="Mean Brier" value={f3(d.brier as number)} />
                <TipRow label="Orders" value={`${d.seeds as number} of ${seeds}`} />
                <div className="text-[11px] text-slate-500">scored on the next {batch} arrivals</div>
              </Tip>
            ) : null;
          }} />
        </ComposedChart>
      </ChartContainer>
    </div>
  );
}

export function LearningCurves({ replay, className }: { replay: Schemas["ReplayResponse"]; className?: string }) {
  const all = TARGET_IDS.flatMap((t) => replay.learning_curve[t] ?? []);
  if (!all.length) return null;
  const lowest = Math.min(...all.map((p) => p.auc_min));
  const yMin = Math.min(0.5, Math.floor(lowest * 10) / 10); // keep chance (0.5) in view; never clip a band
  const rows = TARGET_IDS.flatMap((t) => (replay.learning_curve[t] ?? []).map((p) => ({ target: t, ...p })));
  return (
    <Card title="Learning curves" testId="learning-curves" className={className}
          info="For each vessel model: the forward-holdout AUC of a model trained on that many patients, averaged over the random arrival orders. The band is the lowest to highest AUC across orders. A rising curve suggests more verified cases may help; it is not temporal validation."
          subtitle={`AUC on the next ${replay.holdout_batch_size} arrivals · line = mean of ${replay.seeds} orders · band = min–max · dashed = chance (0.5)`}
          actions={<ExportButtons name="learning-curves" rows={rows}
                                  meta={{ title: replay.title, seeds: replay.seeds, holdout_batch_size: replay.holdout_batch_size,
                                    families: replay.families, replay_config_sha256: replay.replay_config_sha256 }} />}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {TARGET_IDS.map((t) => (
          <LearningCurve key={t} target={t} points={replay.learning_curve[t] ?? []} yMin={yMin}
                         batch={replay.holdout_batch_size} seeds={replay.seeds} />
        ))}
      </div>
    </Card>
  );
}

const gateConfig = {
  PASS: { label: "PASS", color: C.second },
  FAIL: { label: "FAIL (production stays)", color: C.muted },
  INSUFFICIENT_EVIDENCE: { label: "Insufficient evidence", color: C.third },
} satisfies ChartConfig;
const OUTCOMES = ["PASS", "FAIL", "INSUFFICIENT_EVIDENCE"] as const;

export const RULE_TEXT: Record<string, string> = {
  delta_auc_ci_low_above_margin: "ΔAUC 95% CI lower bound > −0.05",
  delta_brier_point_ok: "ΔBrier ≤ +0.01",
  delta_brier_ci_high_ok: "ΔBrier 95% CI upper bound ≤ +0.03",
  cal_slope_ci_overlaps: "calibration-slope CI overlaps [0.8, 1.2]",
  mean_calibration_diff_ok: "|observed − mean predicted| ≤ 0.10",
  improved: "improvement (ΔAUC ≥ +0.01 or ΔBrier ≤ −0.005)",
};

export function GateOutcomes({ replay, className }: { replay: Schemas["ReplayResponse"]; className?: string }) {
  const data = Object.entries(replay.gate_frequencies).map(([gate, f]) => ({
    gate, PASS: f.PASS ?? 0, FAIL: f.FAIL ?? 0, INSUFFICIENT_EVIDENCE: f.INSUFFICIENT_EVIDENCE ?? 0,
  }));
  if (!data.length) return null;
  const count = (v: unknown) => (typeof v === "number" && v > 0 ? `${v}` : ""); // no "0" inside an empty segment
  return (
    <Card title="Replay gate outcomes" testId="gate-outcomes" className={className}
          info="How often each replayed validation gate passed or failed across the random arrival orders. A FAIL keeps the current model; with small holdouts the confidence intervals are wide, so the pre-registered gate is conservative by design."
          subtitle={`${replay.seeds} arrival orders per gate · same pre-registered paired gate as a real candidate`}
          actions={<ExportButtons name="replay-gates" rows={data} meta={{ seeds: replay.seeds }} />}>
      <ChartContainer config={gateConfig} className="aspect-auto w-full" style={{ height: 56 + data.length * 44 }}>
        <BarChart data={data} layout="vertical" margin={{ top: 0, right: 12, bottom: 0, left: 0 }} accessibilityLayer>
          <CartesianGrid horizontal={false} />
          <XAxis type="number" domain={[0, replay.seeds]} ticks={[0, replay.seeds / 2, replay.seeds]} tickFormatter={(v: number) => (Number.isInteger(v) ? `${v}` : v.toFixed(1))} />
          <YAxis type="category" dataKey="gate" width={56} tickLine={false} />
          {OUTCOMES.map((k, i) => (
            <Bar key={k} dataKey={k} stackId="g" fill={`var(--color-${k})`} isAnimationActive={false}
                 radius={i === 0 ? [4, 0, 0, 4] : i === OUTCOMES.length - 1 ? [0, 4, 4, 0] : 0}>
              <LabelList dataKey={k} position="center" className="fill-white text-xs font-bold" formatter={count} />
            </Bar>
          ))}
          <ChartLegend content={<ChartLegendContent />} itemSorter={(i) => OUTCOMES.indexOf(String(i.dataKey) as (typeof OUTCOMES)[number])} />
          <ChartTooltip cursor={false} content={(p: TipProps) => {
            const d = first(p);
            return d ? (
              <Tip>
                <div className="font-semibold capitalize text-slate-900">{d.gate as string}</div>
                {OUTCOMES.map((k) => <TipRow key={k} label={gateConfig[k].label} value={d[k] as number} color={gateConfig[k].color} />)}
              </Tip>
            ) : null;
          }} />
        </BarChart>
      </ChartContainer>
      <FailedRules log={replay.gate_log} />
      <table className="sr-only">
        <caption>Replay gate outcomes</caption>
        <thead><tr><th>Gate</th><th>PASS</th><th>FAIL</th><th>Insufficient evidence</th></tr></thead>
        <tbody>{data.map((d) => <tr key={d.gate}><td>{d.gate}</td><td>{d.PASS}</td><td>{d.FAIL}</td><td>{d.INSUFFICIENT_EVIDENCE}</td></tr>)}</tbody>
      </table>
    </Card>
  );
}

/** In how many replayed gate runs each rule failed for at least one vessel (from the stored gate log). */
function FailedRules({ log }: { log: Schemas["ReplayGate"][] }) {
  const runs = log.length;
  const counts = new Map<string, number>();
  for (const g of log) for (const r of new Set(Object.values(g.failed_rules).flat())) counts.set(r, (counts.get(r) ?? 0) + 1);
  const rows = [...counts].sort((a, b) => b[1] - a[1]);
  if (!runs || !rows.length) return null;
  return (
    <div className="mt-4" data-testid="failed-rules">
      <h3 className="text-xs font-bold text-slate-800">Which rules failed</h3>
      <p className="text-[11px] text-slate-500">gate runs (of {runs}) where the rule failed for at least one vessel</p>
      <ul className="mt-1.5 space-y-1.5">
        {rows.map(([rule, n]) => (
          <li key={rule} className="text-xs text-slate-700">
            <div className="flex justify-between gap-2"><span className="min-w-0">{RULE_TEXT[rule] ?? rule}</span>
              <b className="shrink-0 tabular-nums text-slate-900">{n}/{runs}</b></div>
            <div className="mt-0.5 h-1.5 rounded-full bg-slate-100" aria-hidden>
              <div className="h-1.5 rounded-full" style={{ width: `${(n / runs) * 100}%`, background: C.muted }} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

const MARGIN = -0.05; // pre-registered non-inferiority margin: ΔAUC 95% CI lower bound must lie above it

/** Paired ΔAUC (challenger − production) per vessel with its bootstrap 95% CI, against the gate's −0.05 margin. */
export function DeltaAucChart({ report }: { report: Schemas["ModelReportResponse"] }) {
  const rows = TARGET_IDS.map((t) => {
    const g = report.targets[t]!;
    const delta = g.evaluable && g.auc_champion != null && g.auc_challenger != null ? g.auc_challenger - g.auc_champion : null;
    const lo = g.delta_auc_ci95?.[0] ?? null;
    const hi = g.delta_auc_ci95?.[1] ?? null;
    return { // grey when the margin rule fails, read from the CI itself (rule keys differ between gate versions)
      key: t, label: SHORT[t], value: delta, lo, hi, muted: lo != null && lo <= MARGIN,
      testId: `delta-auc-${t}`,
      right: delta == null ? <Unavailable>insufficient evidence</Unavailable> : (
        <span><b className="text-sm text-slate-900">{signed3(delta)}</b><br />
          <span className="text-[11px] text-slate-500">{lo != null && hi != null ? `[${signed3(lo)}, ${signed3(hi)}]` : "CI not computed"}</span></span>
      ),
    };
  });
  const ends = rows.flatMap((r) => [r.lo, r.hi, r.value]).filter((v): v is number => v != null);
  const lo = Math.floor(Math.min(MARGIN - 0.05, ...ends) * 20) / 20;
  const hi = Math.ceil(Math.max(0.05, ...ends) * 20) / 20;
  const step = hi - lo > 0.3 ? 0.1 : 0.05;
  const ticks: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) ticks.push(Math.round(v * 100) / 100);
  return (
    <div className="mt-2" data-testid="delta-auc-chart">
      <p className="text-xs font-semibold text-slate-800">
        ΔAUC, challenger − production, with 95% CI
        <span className="font-normal text-slate-500"> · dashed line = margin −0.05: the CI lower bound must lie to its right · grey = rule failed</span>
      </p>
      <DotIntervalChart rows={rows} domain={[lo, hi]} ticks={ticks} tickFormat={(v) => (v > 0 ? `+${f2(v)}` : f2(v))}
                        reference={{ x: MARGIN }} xLabel="ΔAUC (0 = no change)" color={C.primary} rowHeight={40}
                        ariaLabel={`Paired ΔAUC per vessel: ${rows.map((r) => `${SHORT[r.key as TargetId]} ${r.value == null ? "not evaluable" : signed3(r.value)}`).join(", ")}`} />
    </div>
  );
}
