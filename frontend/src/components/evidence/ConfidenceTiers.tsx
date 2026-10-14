// Confidence tiers (plan §6.5, D-008, D-024; audit R08/R09): when a prediction is shown with high support. Two scopes,
// never mixed: the threshold regions before the display gates (Table 2) and what users are shown after every gate
// (Table 2b). A metric with no eligible patients is "not estimable", never 0%. Thresholds are read, never changed, here.
import type { ReactNode } from "react";
import { Bar, BarChart, CartesianGrid, LabelList, XAxis, YAxis } from "recharts";
import { TARGET_IDS, type TargetId } from "../../api/client";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "../ui/chart";
import { SHORT } from "../wording";
import { EvidenceIdentityNote, type useBoundEvidence } from "./boundEvidence";
import { C, Card, ExportButtons, InfoTip, Unavailable, countOf, pct1 } from "./kit";

export interface TierStats {
  pct_high_positive: number; pct_high_negative: number; pct_low_confidence: number;
  ppv: number | null; npv: number | null; ppv_ci?: number[] | null; npv_ci?: number[] | null;
  n?: number; n_high_positive?: number; n_high_negative?: number; fp_high_positive?: number; fn_high_negative?: number;
  low_reasons?: Record<string, number>;
}
export interface DisplayedTiers { n_patients: number; scope: string; targets: Partial<Record<TargetId, TierStats>> }
type Bound = ReturnType<typeof useBoundEvidence<DisplayedTiers>>;

const REASONS: Record<string, { label: string; help: string }> = {
  unknown_input: { label: "Input quality: a value unknown",
    help: "A required measurement is UNKNOWN; it is imputed from the training fold and the analysis is never shown with high support." },
  atypical_profile: { label: "Atypical profile",
    help: "The patient's measurements are unusual compared with the training cohort, so the internal evidence may not apply." },
  unstable: { label: "Unstable prediction",
    help: "The 10th–90th percentile of 100 refit-bootstrap predictions straddles the operating threshold t_op, so the call could flip." },
  no_qualified_region: { label: "No qualified region on that side",
    help: "No score range on this side of t_op met the pre-registered target (PPV ≥ 90% or NPV ≥ 95% by the Wilson lower bound, n ≥ 15)." },
  gray_zone: { label: "Between t_op and the region",
    help: "A qualified region exists on this side of t_op, but the score lies between t_op and that region's edge." },
};

const ciText = (ci: number[] | null | undefined) => (ci ? `${pct1(ci[0])}–${pct1(ci[1])}` : null);

function Count({ k, n }: { k: number | null; n: number }) {
  return k == null ? null : <span className="text-xs text-slate-500"> ({k}/{n})</span>;
}

/** A predictive value for a tier: the value with its CI, or why it does not exist. */
function PredictiveValue({ v, ci, k }: { v: number | null; ci?: number[] | null; k: number | null }) {
  if (v == null) return k === 0 ? <Unavailable>not estimable · 0 qualified</Unavailable> : <Unavailable>not available</Unavailable>;
  return <>{pct1(v)}{ci && <span className="text-xs text-slate-500"> [{ciText(ci)}]</span>}</>;
}

interface TierRow { target: TargetId; stats: TierStats }

function TierTable({ rows, target, n, testId }: { rows: TierRow[]; target: TargetId; n: number; testId: string }) {
  return (
    <div className="-mx-4 overflow-x-auto px-4">
      <table className="w-full min-w-[44rem] tabular-nums" data-testid={testId}>
        <thead className="text-xs font-bold uppercase tracking-wide text-slate-600">
          <tr className="border-b-2 border-slate-200 text-left">
            <th scope="col" className="py-2 pr-3">Target</th>
            <th scope="col" className="px-3 py-2 text-right">Qualified positive</th>
            <th scope="col" className="px-3 py-2 text-right">PPV [95% CI]</th>
            <th scope="col" className="px-3 py-2 text-right">Qualified negative</th>
            <th scope="col" className="px-3 py-2 text-right">NPV [95% CI]</th>
            <th scope="col" className="py-2 pl-3 text-right">Outside qualified range</th>
          </tr>
        </thead>
        <tbody className="text-sm">
          {rows.map(({ target: t, stats: r }) => {
            const kPos = r.n_high_positive ?? countOf(r.pct_high_positive, n);
            const kNeg = r.n_high_negative ?? countOf(r.pct_high_negative, n);
            return (
              <tr key={t} className={`border-t border-slate-200 ${t === target ? "bg-sky-50 font-semibold" : ""}`}>
                <th scope="row" className="py-2.5 pr-3 text-left font-semibold">{SHORT[t]}</th>
                <td className="px-3 text-right">{pct1(r.pct_high_positive)}<Count k={kPos} n={n} /></td>
                <td className="px-3 text-right"><PredictiveValue v={r.ppv} ci={r.ppv_ci} k={kPos} /></td>
                <td className="px-3 text-right">{pct1(r.pct_high_negative)}<Count k={kNeg} n={n} /></td>
                <td className="px-3 text-right"><PredictiveValue v={r.npv} ci={r.npv_ci} k={kNeg} /></td>
                <td className="pl-3 text-right">{pct1(r.pct_low_confidence)}<Count k={countOf(r.pct_low_confidence, n)} n={n} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function StatCard({ label, value, detail, help, tone = "default", testId }: {
  label: string; value: ReactNode; detail: ReactNode; help: string; tone?: "default" | "pos" | "out"; testId?: string;
}) {
  const bar = tone === "pos" ? C.primary : tone === "out" ? C.outside : "#e2e8f0";
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4" style={{ borderTop: `4px solid ${bar}` }} data-testid={testId}>
      <p className="text-sm font-semibold text-slate-600">{label}<InfoTip text={help} label={`About ${label}`} /></p>
      <p className="mt-1 text-2xl font-bold tabular-nums text-slate-900">{value}</p>
      <p className="mt-0.5 text-xs text-slate-600">{detail}</p>
    </div>
  );
}

function TierCards({ s, target, n }: { s: TierStats; target: TargetId; n: number }) {
  const kPos = s.n_high_positive ?? countOf(s.pct_high_positive, n);
  const kNeg = s.n_high_negative ?? countOf(s.pct_high_negative, n);
  const kOut = countOf(s.pct_low_confidence, n);
  const sums = kPos != null && kNeg != null && kOut != null;
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5" data-testid="tier-cards">
        <StatCard label={`Qualified positive · ${SHORT[target]}`} tone="pos" testId="tier-card-pos"
                  value={pct1(s.pct_high_positive)} detail={kPos != null ? `${kPos} of ${n} patients` : "of all patients"}
                  help="Share of patients shown as positive with high support, after every display gate." />
        <StatCard label="PPV, qualified positive" testId="tier-card-ppv"
                  value={s.ppv != null ? pct1(s.ppv) : <Unavailable>not estimable</Unavailable>}
                  detail={s.ppv != null
                    ? <>95% CI {ciText(s.ppv_ci) ?? "not computed"}{kPos != null && s.fp_high_positive != null && ` · ${kPos - s.fp_high_positive} of ${kPos} truly positive`}</>
                    : kPos === 0 ? "no patient qualified positive, so there is nothing to measure (not 0%)" : "not available"}
                  help="Of the qualified-positive patients, the share whose label is positive. Patient-level bootstrap 95% CI." />
        <StatCard label="Qualified negative" testId="tier-card-neg"
                  value={pct1(s.pct_high_negative)} detail={kNeg != null ? `${kNeg} of ${n} patients` : "of all patients"}
                  help="Share of patients shown as negative with high support, after every display gate." />
        <StatCard label="NPV, qualified negative" testId="tier-card-npv"
                  value={s.npv != null ? pct1(s.npv) : <Unavailable>not estimable</Unavailable>}
                  detail={s.npv != null
                    ? <>95% CI {ciText(s.npv_ci) ?? "not computed"}{kNeg != null && s.fn_high_negative != null && ` · ${kNeg - s.fn_high_negative} of ${kNeg} truly negative`}</>
                    : kNeg === 0 ? "no patient qualified negative, so there is nothing to measure (not 0%)" : "not available"}
                  help="Of the qualified-negative patients, the share whose label is negative. Patient-level bootstrap 95% CI." />
        <StatCard label="Outside qualified range" tone="out" testId="tier-card-out"
                  value={pct1(s.pct_low_confidence)} detail={kOut != null ? `${kOut} of ${n} patients · still get a prediction` : "still get a prediction"}
                  help="Patients whose analysis is shown without high support: the score is outside every qualified region, or a display gate applied." />
      </div>
      {sums && (
        <p className="text-xs text-slate-600" data-testid="tier-reconcile">
          {kPos} qualified positive + {kNeg} qualified negative + {kOut} outside = {kPos + kNeg + kOut} of {n} patients
          {kPos + kNeg + kOut === n ? " ✓" : " (does not reconcile, check the evaluation output)"}
        </p>
      )}
    </div>
  );
}

const coverageConfig = {
  pos: { label: "Qualified positive", color: C.primary },
  neg: { label: "Qualified negative", color: C.second },
  out: { label: "Outside qualified range", color: C.outside },
} satisfies ChartConfig;

function CoverageChart({ before, after, target }: { before: TierRow[]; after: TierRow[] | null; target: TargetId }) {
  const data = TARGET_IDS.flatMap((t) => {
    const rows: { row: string; target: TargetId; scope: string; pos: number; neg: number; out: number }[] = [];
    const b = before.find((r) => r.target === t)?.stats;
    const a = after?.find((r) => r.target === t)?.stats;
    if (b) rows.push({ row: `${SHORT[t]} · before gates`, target: t, scope: "threshold regions, before display gates",
      pos: b.pct_high_positive * 100, neg: b.pct_high_negative * 100, out: b.pct_low_confidence * 100 });
    if (a) rows.push({ row: `${SHORT[t]} · after gates`, target: t, scope: "as displayed, after every gate",
      pos: a.pct_high_positive * 100, neg: a.pct_high_negative * 100, out: a.pct_low_confidence * 100 });
    return rows;
  });
  const label = (v: unknown) => (typeof v === "number" && v >= 7 ? `${v.toFixed(1)}%` : "");
  return (
    <Card title="Coverage by tier, before and after the display gates" testId="tier-coverage-chart"
          subtitle="share of all patients in each tier · every patient still gets a prediction"
          actions={<ExportButtons name="tier-coverage" rows={data.map((d) => ({ target: d.target, scope: d.scope,
            qualified_positive: d.pos / 100, qualified_negative: d.neg / 100, outside_qualified_range: d.out / 100 }))} />}>
      <ChartContainer config={coverageConfig} className="aspect-auto w-full" style={{ height: data.length * 34 + 70 }}>
        <BarChart data={data} layout="vertical" margin={{ left: 4, right: 12, top: 0, bottom: 0 }} accessibilityLayer barCategoryGap={6}>
          <CartesianGrid horizontal={false} />
          <XAxis type="number" domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tickFormatter={(v) => `${v}%`} tickLine={false} />
          <YAxis type="category" dataKey="row" width={128} tickLine={false} axisLine={false}
                 tick={(props: unknown) => {
                   const p = props as { x: number; y: number; payload: { value: string } };
                   const ours = p.payload.value.startsWith(`${SHORT[target]} ·`);
                   return <text x={p.x} y={p.y} dy={4} textAnchor="end" className={`text-[11px] ${ours ? "fill-slate-900 font-bold" : "fill-slate-600"}`}>{p.payload.value}</text>;
                 }} />
          <ChartTooltip cursor={{ fill: "rgba(15,23,42,0.04)" }}
                        content={<ChartTooltipContent formatter={(v, name) => (
                          <span className="flex w-full justify-between gap-3">
                            <span className="text-slate-600">{coverageConfig[name as keyof typeof coverageConfig]?.label ?? name}</span>
                            <span className="font-semibold tabular-nums">{Number(v).toFixed(1)}%</span>
                          </span>
                        )} />} />
          <ChartLegend content={<ChartLegendContent />} itemSorter={(i) => ["pos", "neg", "out"].indexOf(String(i.dataKey))} />
          {(["pos", "neg", "out"] as const).map((k) => (
            <Bar key={k} dataKey={k} stackId="a" fill={`var(--color-${k})`} isAnimationActive={false}>
              <LabelList dataKey={k} position="center" formatter={label}
                         className={k === "out" ? "fill-slate-800 text-[11px] font-semibold" : "fill-white text-[11px] font-semibold"} />
            </Bar>
          ))}
        </BarChart>
      </ChartContainer>
    </Card>
  );
}

const reasonConfig = { count: { label: "Patients", color: C.muted } } satisfies ChartConfig;

function ReasonsChart({ s, target, n }: { s: TierStats; target: TargetId; n: number }) {
  const data = Object.entries(s.low_reasons ?? {}).sort((a, b) => b[1] - a[1])
    .map(([k, count]) => ({ key: k, reason: REASONS[k]?.label ?? k, count }));
  const kOut = countOf(s.pct_low_confidence, n);
  if (!data.length) return null;
  return (
    <Card title={`Why analyses fall outside the qualified range · ${SHORT[target]}`} testId="tier-reasons"
          subtitle={<>after every display gate{kOut != null && ` · ${kOut} of ${n} patients outside`} · a patient can have
            several reasons, so the counts overlap and do not add up to the total</>}
          actions={<ExportButtons name={`tier-reasons-${target}`} rows={data.map((d) => ({ target, reason: d.key, patients: d.count, n }))} />}>
      <ChartContainer config={reasonConfig} className="aspect-auto w-full" style={{ height: data.length * 34 + 30 }}>
        <BarChart data={data} layout="vertical" margin={{ left: 4, right: 40, top: 0, bottom: 0 }} accessibilityLayer>
          <CartesianGrid horizontal={false} />
          <XAxis type="number" domain={[0, n]} tickLine={false} />
          <YAxis type="category" dataKey="reason" width={190} tickLine={false} axisLine={false} className="text-[11px]" />
          <ChartTooltip cursor={{ fill: "rgba(15,23,42,0.04)" }} content={<ChartTooltipContent hideIndicator />} />
          <Bar dataKey="count" fill="var(--color-count)" radius={3} isAnimationActive={false}>
            <LabelList dataKey="count" position="right" className="fill-slate-800 text-[11px] font-semibold" />
          </Bar>
        </BarChart>
      </ChartContainer>
      <dl className="mt-2 grid gap-x-6 gap-y-1 text-xs text-slate-600 md:grid-cols-2">
        {data.map((d) => (
          <div key={d.key}><dt className="inline font-semibold text-slate-800">{d.reason}: </dt><dd className="inline">{REASONS[d.key]?.help}</dd></div>
        ))}
      </dl>
    </Card>
  );
}

export function ConfidenceTiers({ table2, target, tiers, nPatients }: {
  table2: readonly { target: string }[]; target: TargetId; tiers: Bound; nPatients: number;
}) {
  const before: TierRow[] = TARGET_IDS.flatMap((t) => {
    const r = table2.find((x) => x.target === t);
    return r ? [{ target: t, stats: r as unknown as TierStats }] : [];
  });
  const after: TierRow[] | null = tiers.data
    ? TARGET_IDS.flatMap((t) => (tiers.data!.targets[t] ? [{ target: t, stats: tiers.data!.targets[t]! }] : []))
    : null;
  const nAfter = tiers.data?.n_patients ?? nPatients;
  const sel = after?.find((r) => r.target === target)?.stats;
  const exportRows = (rows: TierRow[], scope: string, n: number) => rows.map(({ target: t, stats: s }) => ({
    target: t, scope, n, qualified_positive_share: s.pct_high_positive, qualified_positive_n: s.n_high_positive ?? countOf(s.pct_high_positive, n),
    ppv: s.ppv, ppv_ci_low: s.ppv_ci?.[0] ?? null, ppv_ci_high: s.ppv_ci?.[1] ?? null,
    qualified_negative_share: s.pct_high_negative, qualified_negative_n: s.n_high_negative ?? countOf(s.pct_high_negative, n),
    npv: s.npv, npv_ci_low: s.npv_ci?.[0] ?? null, npv_ci_high: s.npv_ci?.[1] ?? null,
    outside_share: s.pct_low_confidence, outside_n: countOf(s.pct_low_confidence, n),
  }));
  return (
    <div className="space-y-4">
      <EvidenceIdentityNote identity={tiers.identity} activeModel={tiers.activeModel} mock={tiers.mock} current={tiers.current} />
      <Card title="How a prediction qualifies for high support" testId="tier-criteria">
        <ol className="grid gap-3 text-sm text-slate-700 md:grid-cols-3">
          <li className="rounded-md bg-slate-50 p-3">
            <b className="block text-slate-900">1 · Score in a qualified region</b>
            A score range qualifies only if, on training-side out-of-fold scores, the Wilson 95% lower bound met the
            pre-registered target (PPV ≥ 90% above t_pos, NPV ≥ 95% below t_neg) with at least 15 patients. The targets were
            fixed before results and are never lowered.
          </li>
          <li className="rounded-md bg-slate-50 p-3">
            <b className="block text-slate-900">2 · Display gates</b>
            Input quality (any UNKNOWN value), an atypical profile, and stability (refit-bootstrap interval straddling t_op)
            each move an analysis outside the qualified range, even when its score lies in a region.
          </li>
          <li className="rounded-md bg-slate-50 p-3">
            <b className="block text-slate-900">3 · Every patient still gets a prediction</b>
            Outside the qualified range is not a refusal: the probability and binary call at t_op are still shown. High
            support reflects internal evaluation on this cohort, not clinical validation.
          </li>
        </ol>
      </Card>
      {sel && <TierCards s={sel} target={target} n={nAfter} />}
      <CoverageChart before={before} after={after} target={target} />
      {sel && <ReasonsChart s={sel} target={target} n={nAfter} />}
      <Card title="Table 2b · confidence as displayed to users" label="Confidence tiers as displayed"
            subtitle={<>served out-of-fold analyses, after every display gate (input quality, atypical profile, stability) ·
              patient-level bootstrap 95% CI · n = {nAfter}</>}
            actions={after && <ExportButtons name="tiers-displayed" rows={exportRows(after, "after display gates", nAfter)}
                                             meta={{ scope: tiers.data?.scope, model_version: tiers.identity?.model_version }} />}>
        {after ? <TierTable rows={after} target={target} n={nAfter} testId="tiers-displayed" />
          : <p className="text-sm text-slate-600">{tiers.error ? "Displayed-tier evidence unavailable." : "Loading…"}</p>}
      </Card>
      <Card title="Table 2 · threshold regions, before the display gates" label="Threshold-region tiers"
            info="Pooled OOF (prespecified repeat), patient-level bootstrap 95% CI. A region qualifies only if the Wilson lower bound meets the pre-registered PPV ≥ 90% / NPV ≥ 95% (targets never moved)."
            subtitle={`pooled OOF (prespecified repeat) · where a score met the pre-registered target · n = ${nPatients}`}
            actions={<ExportButtons name="tiers-threshold" rows={exportRows(before, "threshold regions, before display gates", nPatients)} />}>
        <TierTable rows={before} target={target} n={nPatients} testId="tiers-threshold" />
      </Card>
      <p className="text-sm text-slate-700">
        The display gates move some patients out of the qualified regions, so fewer are shown with high support (Table 2b)
        than fall in the regions (Table 2). &quot;Not estimable&quot; means no patient was in that tier, so its predictive
        value does not exist; it is not a measured 0%.
      </p>
    </div>
  );
}
