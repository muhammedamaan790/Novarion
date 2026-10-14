// Clinical-standard evidence (D-021, D-035): CAD against the historical guideline pretest score (updated Diamond–Forrester,
// ESC 2013), calibration beyond AUC, and subgroup performance — the reporting gaps an umbrella review of cardiovascular AI
// flags. Static, precomputed from the frozen out-of-fold predictions (scripts/clinical_evaluation.py); works offline.
// Only computed statistics are drawn: the single-model AUCs have no CI here, so only the paired difference carries one.
import type { TargetId } from "../../api/client";
import { SHORT } from "../wording";
import { EvidenceIdentityNote, useBoundEvidence } from "./boundEvidence";
import { C, Card, DotIntervalChart, ExportButtons, Unavailable, f3, pct1, signed3 } from "./kit";

interface Compare { auc_new: number; auc_old: number; delta_auc: number; delta_auc_ci95: number[]; nri: number; idi: number }
interface Cal { brier: number; calibration_in_the_large: number; ece: number; calibration_slope?: number }
interface Band { n?: number; share: number; observed_cad_rate: number | null }
interface SubRow { n: number; n_positive: number; auc?: number; auc_ci95?: number[]; sensitivity?: number;
  specificity?: number; calibration_in_the_large?: number; status?: string }
interface ClinicalEvaluation {
  bootstrap?: number;
  clinical_baseline: { n: number; population: string; cad_prevalence?: number; novarion_vs_published_df: Compare;
    novarion_vs_df_inputs_refit: Compare; calibration: Record<"novarion" | "published_df" | "df_inputs_refit", Cal>;
    esc_pretest_bands: Record<"novarion" | "published_df", Record<string, Band>> };
  subgroups: Record<TargetId, Record<string, SubRow>>;
}

const ci = (c: number[] | undefined) => (c ? `[${f3(c[0]!)}, ${f3(c[1]!)}]` : "");
const COMPARATORS = [
  ["novarion", "NOVARION (all measurements)"],
  ["published_df", "Diamond–Forrester (published)"],
  ["df_inputs_refit", "Same 3 inputs, refit"],
] as const;

export function ClinicalBenchmark({ target }: { target: TargetId }) {
  const ev = useBoundEvidence<ClinicalEvaluation>("clinical_evaluation");
  if (ev.error) return <p className="text-sm text-slate-600">Clinical evaluation unavailable.</p>;
  if (!ev.data?.clinical_baseline || !ev.data.subgroups?.[target]) return null;
  const cb = ev.data.clinical_baseline;
  const auc = { novarion: cb.novarion_vs_published_df.auc_new, published_df: cb.novarion_vs_published_df.auc_old,
    df_inputs_refit: cb.novarion_vs_df_inputs_refit.auc_old };
  const deltas = [
    { key: "vs_published_df", label: "vs Diamond–Forrester (published)", c: cb.novarion_vs_published_df },
    { key: "vs_df_inputs_refit", label: "vs same 3 inputs, refit", c: cb.novarion_vs_df_inputs_refit },
  ];
  const rows = Object.entries(ev.data.subgroups[target]);
  const boot = ev.data.bootstrap;
  return (
    <div className="space-y-4" data-testid="clinical-benchmark">
      <EvidenceIdentityNote identity={ev.identity} activeModel={ev.activeModel} mock={ev.mock} current={ev.current} />
      <section aria-label="Versus the guideline pretest score" className="space-y-4">
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="text-base font-bold text-slate-900">CAD versus the guideline pretest score</h2>
          <p className="mt-0.5 text-xs text-slate-600">
            Comparator: updated Diamond–Forrester (age × sex × chest-pain type), the <b>ESC 2013 pretest table, a historical
            comparator</b> superseded by later ESC guidance · {cb.population} ·
            out-of-fold, paired bootstrap 95% CI{boot ? ` (${boot} replicates)` : ""} · applies to overall CAD only, whichever target is selected
          </p>
          <div className="mt-4 grid gap-6">
            <div data-testid="guideline-auc">
              <div className="flex items-start justify-between gap-2">
                <h3 className="text-sm font-semibold text-slate-900">Discrimination (ROC-AUC, CAD)</h3>
                <ExportButtons name="guideline-auc" rows={COMPARATORS.map(([k, label]) => ({ model: label, auc: auc[k], auc_ci95: null }))}
                               meta={{ population: cb.population, n: cb.n }} />
              </div>
              <DotIntervalChart ariaLabel="ROC-AUC of NOVARION and the guideline comparators" xLabel="ROC-AUC (0.5 = chance)"
                                domain={[0.5, 1]} ticks={[0.5, 0.6, 0.7, 0.8, 0.9, 1]} reference={{ x: 0.5 }} rowHeight={32}
                                cols="minmax(9rem,16rem) minmax(0,1fr) minmax(5rem,8rem)"
                                rows={COMPARATORS.map(([k, label]) => ({ key: k, label, value: auc[k], right: f3(auc[k]),
                                  highlight: k === "novarion", muted: k !== "novarion" }))} />
              <p className="mt-1 text-xs text-slate-600">
                Point estimates only: CIs for the single AUCs were not computed. The paired difference (right) carries the uncertainty.
              </p>
            </div>
            <div data-testid="guideline-delta">
              <div className="flex items-start justify-between gap-2">
                <h3 className="text-sm font-semibold text-slate-900">Paired ΔAUC, NOVARION minus comparator</h3>
                <ExportButtons name="guideline-delta-auc" meta={{ population: cb.population, n: cb.n, bootstrap: boot }}
                               rows={deltas.map((d) => ({ comparison: d.key, delta_auc: d.c.delta_auc,
                                 ci95_low: d.c.delta_auc_ci95[0] ?? null, ci95_high: d.c.delta_auc_ci95[1] ?? null }))} />
              </div>
              <DotIntervalChart ariaLabel="Paired difference in ROC-AUC with 95% confidence intervals" xLabel="ΔAUC (0 = no difference)"
                                domain={[-0.05, 0.2]} ticks={[-0.05, 0, 0.05, 0.1, 0.15, 0.2]} tickFormat={(v) => (v < 0 ? `−${Math.abs(v).toFixed(2)}` : v.toFixed(2))}
                                reference={{ x: 0 }} rowHeight={40} color={C.second}
                                cols="minmax(9rem,16rem) minmax(0,1fr) minmax(5rem,8rem)"
                                rows={deltas.map((d) => ({ key: d.key, label: d.label, value: d.c.delta_auc,
                                  lo: d.c.delta_auc_ci95[0], hi: d.c.delta_auc_ci95[1],
                                  right: <><span className="block font-semibold text-slate-900">{signed3(d.c.delta_auc)}</span>
                                    <span className="block text-[11px] text-slate-500">{ci(d.c.delta_auc_ci95)}</span></> }))} />
              <p className="mt-1 text-xs text-slate-700">
                ΔAUC vs published score <b>{signed3(cb.novarion_vs_published_df.delta_auc)}</b> {ci(cb.novarion_vs_published_df.delta_auc_ci95)} ·
                vs the same three inputs refit on our folds <b>{signed3(cb.novarion_vs_df_inputs_refit.delta_auc)}</b>{" "}
                {ci(cb.novarion_vs_df_inputs_refit.delta_auc_ci95)}: the refit row isolates what the other measurements add
                beyond age, sex and chest-pain type, on this cohort.
              </p>
            </div>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Calibration on the same patients" subtitle={`CAD · ${cb.n} patients · out-of-fold`}
                actions={<ExportButtons name="guideline-calibration" rows={COMPARATORS.map(([k, label]) => ({ model: label, ...cb.calibration[k] }))} />}>
            <div className="-mx-4 overflow-x-auto px-4">
              <table className="w-full min-w-[26rem] text-sm tabular-nums">
                <thead className="text-xs font-bold uppercase tracking-wide text-slate-600">
                  <tr className="border-b-2 border-slate-200">
                    <th scope="col" className="py-2 pr-2 text-left">Model</th>
                    <th scope="col" className="px-2 text-right" title="0 = ideal">Cal.-in-the-large <span className="block text-[10px] normal-case tracking-normal text-slate-500">→0 best</span></th>
                    <th scope="col" className="px-2 text-right" title="expected calibration error">ECE <span className="block text-[10px] normal-case tracking-normal text-slate-500">↓ lower</span></th>
                    <th scope="col" className="pl-2 text-right">Brier <span className="block text-[10px] normal-case tracking-normal text-slate-500">↓ lower</span></th>
                  </tr>
                </thead>
                <tbody>
                  {COMPARATORS.map(([k, label]) => (
                    <tr key={k} className={`border-t border-slate-200 ${k === "novarion" ? "bg-sky-50" : ""}`}>
                      <th scope="row" className="py-2 pr-2 text-left font-medium">{label}</th>
                      <td className="px-2 text-right">{signed3(cb.calibration[k].calibration_in_the_large)}</td>
                      <td className="px-2 text-right">{f3(cb.calibration[k].ece)}</td>
                      <td className="pl-2 text-right">{f3(cb.calibration[k].brier)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          <Card title="ESC 2013 pretest bands (historical)" subtitle="share of patients in each band, with the observed CAD rate in brackets"
                actions={<ExportButtons name="guideline-esc-bands" rows={Object.keys(cb.esc_pretest_bands.novarion).flatMap((band) =>
                  (["novarion", "published_df"] as const).map((m) => ({ band, model: m, ...cb.esc_pretest_bands[m][band] })))} />}>
            <div className="-mx-4 overflow-x-auto px-4">
              <table className="w-full min-w-[26rem] text-sm tabular-nums">
                <thead className="text-xs font-bold uppercase tracking-wide text-slate-600">
                  <tr className="border-b-2 border-slate-200">
                    <th scope="col" className="py-2 pr-2 text-left">Band</th>
                    <th scope="col" className="px-2 text-right">NOVARION</th>
                    <th scope="col" className="pl-2 text-right">Diamond–Forrester</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.keys(cb.esc_pretest_bands.novarion).map((band) => {
                    const a = cb.esc_pretest_bands.novarion[band]!;
                    const b = cb.esc_pretest_bands.published_df[band]!;
                    return (
                      <tr key={band} className="border-t border-slate-200">
                        <th scope="row" className="py-2 pr-2 text-left font-medium">{band}</th>
                        <td className="px-2 text-right">{pct1(a.share)}{a.n != null && <span className="text-xs text-slate-500"> n {a.n}</span>} ({pct1(a.observed_cad_rate)})</td>
                        <td className="pl-2 text-right">{pct1(b.share)}{b.n != null && <span className="text-xs text-slate-500"> n {b.n}</span>} ({pct1(b.observed_cad_rate)})</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs text-slate-600">
              Descriptive only: bands are the guideline&apos;s pretest categories; NOVARION does not recommend tests or treatment.
              Internal validation on one cohort; the published score was derived elsewhere.
            </p>
          </Card>
        </div>
      </section>

      <Card title={`Subgroup performance · ${SHORT[target]}`} label="Subgroup performance" testId="subgroups"
            subtitle="out-of-fold · AUC with bootstrap 95% CI · descriptive: one cohort of 303, so intervals are wide and no fairness claim is made; cells with fewer than 10 per class are suppressed"
            actions={<ExportButtons name={`subgroups-${target}`} rows={rows.map(([g, r]) => ({ target, subgroup: g, n: r.n, n_positive: r.n_positive,
              auc: r.auc ?? null, auc_ci95_low: r.auc_ci95?.[0] ?? null, auc_ci95_high: r.auc_ci95?.[1] ?? null,
              sensitivity: r.sensitivity ?? null, specificity: r.specificity ?? null,
              calibration_in_the_large: r.calibration_in_the_large ?? null, status: r.status ?? null }))} />}>
        <DotIntervalChart ariaLabel={`Subgroup ROC-AUC for ${SHORT[target]} with 95% confidence intervals`}
                          xLabel="ROC-AUC with bootstrap 95% CI (0.5 = chance)" domain={[0.5, 1]} ticks={[0.5, 0.6, 0.7, 0.8, 0.9, 1]}
                          reference={{ x: 0.5 }} rowHeight={40} cols="minmax(5.5rem,9rem) minmax(0,1fr) minmax(7rem,9rem)"
                          rows={rows.map(([g, r]) => ({ key: g, value: r.auc ?? null, lo: r.auc_ci95?.[0], hi: r.auc_ci95?.[1],
                            highlight: g === "all", muted: g !== "all",
                            label: <><span className="block">{g}</span><span className="block text-[11px] font-normal text-slate-500">n {r.n} · {r.n_positive} pos.</span></>,
                            right: r.auc != null
                              ? <><span className="block font-semibold text-slate-900">{f3(r.auc)}</span><span className="block text-[11px] text-slate-500">{ci(r.auc_ci95)}</span></>
                              : <Unavailable>{r.status ?? "suppressed"}</Unavailable> }))} />
        <div className="-mx-4 mt-4 overflow-x-auto px-4">
          <table className="w-full min-w-[34rem] text-sm tabular-nums" data-testid="subgroup-table">
            <thead className="text-xs font-bold uppercase tracking-wide text-slate-600">
              <tr className="border-b-2 border-slate-200">
                <th scope="col" className="py-2 pr-2 text-left">Subgroup</th>
                <th scope="col" className="px-2 text-right">n (pos.)</th>
                <th scope="col" className="px-2 text-right">AUC [95% CI]</th>
                <th scope="col" className="px-2 text-right">Sens.</th>
                <th scope="col" className="px-2 text-right">Spec.</th>
                <th scope="col" className="pl-2 text-right">Cal.-in-large</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([g, r]) => (
                <tr key={g} className={`border-t border-slate-200 ${g === "all" ? "bg-sky-50" : ""}`}>
                  <th scope="row" className="py-2 pr-2 text-left font-medium">{g}</th>
                  <td className="px-2 text-right">{r.n} ({r.n_positive})</td>
                  {r.auc != null ? (
                    <>
                      <td className="px-2 text-right">{f3(r.auc)} <span className="text-xs text-slate-500">{ci(r.auc_ci95)}</span></td>
                      <td className="px-2 text-right">{pct1(r.sensitivity)}</td>
                      <td className="px-2 text-right">{pct1(r.specificity)}</td>
                      <td className="pl-2 text-right">{r.calibration_in_the_large != null ? signed3(r.calibration_in_the_large) : "—"}</td>
                    </>
                  ) : <td colSpan={4} className="text-right"><Unavailable>{r.status}</Unavailable></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-slate-600">
          Sensitivity and specificity are at the operating threshold t_op and are point estimates: their intervals were not
          computed in this evaluation. Small subgroups (for example age &lt; 50, n 58) carry wide uncertainty. These
          descriptive results do not establish fairness or its absence.
        </p>
      </Card>

      <Card title="ESC 2024 clinical-likelihood model: not yet compared" testId="esc2024-feasibility"
            subtitle="feasibility assessment, no result shown">
        <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
          <li>
            <b>Inputs available:</b> the risk-factor-weighted clinical likelihood (RF-CL) uses age, sex, symptom type
            (typical, atypical, non-anginal, dyspnoea) and the count of risk factors (family history, smoking,
            dyslipidaemia, hypertension, diabetes). All are recorded in this dataset.
          </li>
          <li>
            <b>Comparability limits:</b> our reference standard is ≥ 50% stenosis on invasive angiography in patients already
            referred for it (71% CAD prevalence); RF-CL was developed for obstructive CAD in lower-prevalence symptomatic
            populations, so its absolute probabilities may not be calibrated to this cohort. The comparison would be about
            discrimination first, with calibration interpreted cautiously.
          </li>
          <li>
            <b>Needed:</b> computing it in the evaluation pipeline (scripts/clinical_evaluation.py) with the same paired
            bootstrap. It is not drawn here because no result exists yet.
          </li>
        </ul>
      </Card>
    </div>
  );
}
