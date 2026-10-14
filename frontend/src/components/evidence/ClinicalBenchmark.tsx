// Clinical-standard evidence (D-021): CAD against the guideline pretest score (updated Diamond–Forrester), calibration
// beyond AUC, and subgroup performance — the reporting gaps an umbrella review of cardiovascular AI flags. Static,
// precomputed from the frozen out-of-fold predictions (scripts/clinical_evaluation.py); works offline.
import type { TargetId } from "../../api/client";
import { SHORT } from "../wording";
import { EvidenceIdentityNote, useBoundEvidence } from "./boundEvidence";

interface Compare { auc_new: number; auc_old: number; delta_auc: number; delta_auc_ci95: number[]; nri: number; idi: number }
interface Cal { brier: number; calibration_in_the_large: number; ece: number }
interface Band { share: number; observed_cad_rate: number | null }
interface SubRow { n: number; n_positive: number; auc?: number; auc_ci95?: number[]; sensitivity?: number;
  specificity?: number; calibration_in_the_large?: number; status?: string }
interface ClinicalEvaluation {
  clinical_baseline: { n: number; population: string; novarion_vs_published_df: Compare; novarion_vs_df_inputs_refit: Compare;
    calibration: Record<"novarion" | "published_df" | "df_inputs_refit", Cal>;
    esc_pretest_bands: Record<"novarion" | "published_df", Record<string, Band>> };
  subgroups: Record<TargetId, Record<string, SubRow>>;
}

const pct = (v: number | null | undefined) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);
const f3 = (v: number) => v.toFixed(3);
const ci = (c: number[] | undefined) => (c ? `[${f3(c[0]!)}, ${f3(c[1]!)}]` : "");

export function ClinicalBenchmark({ target }: { target: TargetId }) {
  const ev = useBoundEvidence<ClinicalEvaluation>("clinical_evaluation");
  if (ev.error) return <p className="text-sm text-slate-600">Clinical evaluation unavailable.</p>;
  if (!ev.data?.clinical_baseline || !ev.data.subgroups?.[target]) return null;
  const cb = ev.data.clinical_baseline;
  const rows = Object.entries(ev.data.subgroups[target]);
  return (
    <div className="space-y-3">
    <EvidenceIdentityNote identity={ev.identity} activeModel={ev.activeModel} mock={ev.mock} current={ev.current} />
    <div className="grid gap-4 lg:grid-cols-[1fr_1fr]" data-testid="clinical-benchmark">
      <section className="rounded-lg border border-slate-200 bg-white p-3" aria-label="Versus the guideline pretest score">
        <h2 className="text-sm font-semibold text-slate-900">CAD versus the guideline pretest score</h2>
        <p className="mb-2 text-[11px] text-slate-500">
          Updated Diamond–Forrester (age × sex × chest-pain type; ESC 2013) · {cb.n} patients with a chest-pain type ·
          out-of-fold, paired bootstrap 95% CI
        </p>
        <table className="w-full text-xs tabular-nums">
          <thead className="text-left text-slate-500">
            <tr><th className="pr-2">Model</th><th className="pr-2">AUC</th><th className="pr-2">Calibration-in-the-large</th>
              <th className="pr-2">ECE</th><th>Brier</th></tr>
          </thead>
          <tbody>
            {([["NOVARION", cb.calibration.novarion, cb.novarion_vs_published_df.auc_new],
               ["Diamond–Forrester (published)", cb.calibration.published_df, cb.novarion_vs_published_df.auc_old],
               ["Same 3 inputs, refit", cb.calibration.df_inputs_refit, cb.novarion_vs_df_inputs_refit.auc_old]] as const)
              .map(([label, cal, auc]) => (
                <tr key={label} className="border-t border-slate-100">
                  <td className="pr-2 font-medium">{label}</td><td className="pr-2">{f3(auc)}</td>
                  <td className="pr-2">{cal.calibration_in_the_large >= 0 ? "+" : ""}{f3(cal.calibration_in_the_large)}</td>
                  <td className="pr-2">{f3(cal.ece)}</td><td>{f3(cal.brier)}</td>
                </tr>
              ))}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-slate-700">
          ΔAUC vs published score <b>+{f3(cb.novarion_vs_published_df.delta_auc)}</b> {ci(cb.novarion_vs_published_df.delta_auc_ci95)} ·
          vs the same three inputs refit on our folds <b>+{f3(cb.novarion_vs_df_inputs_refit.delta_auc)}</b>{" "}
          {ci(cb.novarion_vs_df_inputs_refit.delta_auc_ci95)}: the other measurements add discrimination beyond age, sex
          and chest-pain type.
        </p>
        <table className="mt-2 w-full text-xs tabular-nums">
          <thead className="text-left text-slate-500">
            <tr><th className="pr-2">ESC pretest band</th><th className="pr-2">NOVARION: share (observed CAD)</th>
              <th>Diamond–Forrester: share (observed CAD)</th></tr>
          </thead>
          <tbody>
            {Object.keys(cb.esc_pretest_bands.novarion).map((band) => {
              const a = cb.esc_pretest_bands.novarion[band]!;
              const b = cb.esc_pretest_bands.published_df[band]!;
              return (
                <tr key={band} className="border-t border-slate-100">
                  <td className="pr-2">{band}</td>
                  <td className="pr-2">{pct(a.share)} ({pct(a.observed_cad_rate)})</td>
                  <td>{pct(b.share)} ({pct(b.observed_cad_rate)})</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="mt-1 text-[11px] text-slate-500">
          Descriptive only: bands are the guideline&apos;s pretest categories; NOVARION does not recommend tests or treatment.
          Internal validation on one cohort; the published score was derived elsewhere.
        </p>
      </section>
      <section className="overflow-x-auto rounded-lg border border-slate-200 bg-white p-3" aria-label="Subgroup performance">
        <h2 className="text-sm font-semibold text-slate-900">Subgroup performance · {SHORT[target]}</h2>
        <p className="mb-2 text-[11px] text-slate-500">
          Out-of-fold · bootstrap 95% CI · descriptive: one cohort of 303, so intervals are wide and no fairness claim is
          made; cells with fewer than 10 per class are suppressed.
        </p>
        <table className="w-full text-xs tabular-nums" data-testid="subgroup-table">
          <thead className="text-left text-slate-500">
            <tr><th className="pr-2">Subgroup</th><th className="pr-2">n (pos.)</th><th className="pr-2">AUC [95% CI]</th>
              <th className="pr-2">Sens.</th><th className="pr-2">Spec.</th><th>Cal.-in-large</th></tr>
          </thead>
          <tbody>
            {rows.map(([g, r]) => (
              <tr key={g} className="border-t border-slate-100">
                <td className="pr-2 font-medium">{g}</td><td className="pr-2">{r.n} ({r.n_positive})</td>
                {r.auc != null ? (
                  <>
                    <td className="pr-2">{f3(r.auc)} {ci(r.auc_ci95)}</td><td className="pr-2">{pct(r.sensitivity)}</td>
                    <td className="pr-2">{pct(r.specificity)}</td>
                    <td>{(r.calibration_in_the_large ?? 0) >= 0 ? "+" : ""}{f3(r.calibration_in_the_large ?? 0)}</td>
                  </>
                ) : <td colSpan={4} className="text-slate-500">{r.status}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
    </div>
  );
}
