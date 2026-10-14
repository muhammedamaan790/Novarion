// "Why did the model predict this?" for the selected target (plan §8, §9.2 state 4): contributions in calibrated
// log-odds, presentation-group sums, the measurement table with typed cohort comparisons, then evidence.
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { Contribution, DisplayAnalysis, TargetId } from "../api/client";
import { explainQuery } from "../api/queries";
import { SHORT, TOOLTIPS, pct, probPct } from "./wording";

export const GROUP_LABEL: Record<string, string> = {
  demographics: "Demographics", history: "History / risk factors", symptoms_exam: "Symptoms & exam",
  ecg: "ECG", labs: "Labs", echo: "Echo",
};

/** The patient's value against the cohort, in words: where it ranks (numbers) or how common it is (categories), among
 *  the patients without and with the target. */
/** One measurement's effect as a defined progress bar: a full track, filled in proportion to the largest effect,
 *  coloured and labelled by direction (never colour alone). */
function EffectBar({ c, max }: { c: { contribution: number; strength: string }; max: number }) {
  const up = c.contribution > 0;
  const width = max === 0 ? 0 : Math.max(2, (Math.abs(c.contribution) / max) * 100);
  return (
    <div className="flex items-center gap-2" title={`${c.strength} effect (${c.contribution >= 0 ? "+" : ""}${c.contribution.toFixed(2)} calibrated log-odds)`}>
      <div className="relative h-3 flex-1 overflow-hidden rounded-full bg-slate-200" aria-hidden>
        <div className={`h-full rounded-full ${up ? "bg-amber-600" : "bg-sky-700"}`} style={{ width: `${width}%` }} />
      </div>
      <span className={`w-16 shrink-0 text-[11px] font-semibold ${up ? "text-amber-800" : "text-sky-800"}`}>
        {up ? "↑ raises" : c.contribution < 0 ? "↓ lowers" : "no effect"}
      </span>
    </div>
  );
}

function comparisonText(c: Contribution, target: TargetId): string {
  const cmp = c.cohort_comparison;
  if (!cmp) return c.value_status === "imputed" ? "imputed — no comparison" : "—";
  const condition = target === "cad" ? "CAD" : `${SHORT[target]} stenosis`;
  const side = (name: "negative" | "positive") => {
    const s = cmp[name];
    const who = `${name === "negative" ? "without" : "with"} ${condition} (n = ${s.n})`;
    if (s.status !== "ok") return `too few patients ${who} to compare`;
    if (cmp.type === "percentile") {
      const p = Math.round(s.percentile ?? 0);
      return p >= 100 ? `the highest among patients ${who}` : p <= 0 ? `the lowest among patients ${who}`
        : p >= 50 ? `higher than ${p}% of patients ${who}` : `lower than ${100 - p}% of patients ${who}`;
    }
    return `${pct(s.rate ?? 0)} of patients ${who} have this value`;
  };
  return `${side("negative")} · ${side("positive")}`;
}

export function WhyPanel({ analysis, target }: { analysis: DisplayAnalysis; target: TargetId }) {
  const [showAll, setShowAll] = useState(false);
  // Persisted / dataset analyses carry their explanations; transient ones fetch them pinned, cached per
  // analysis_id + target, so re-selecting a vessel is instant and an old analysis is never re-explained.
  const stored = analysis.explanations[target];
  const fetched = useQuery(explainQuery(analysis, target));
  const explanation = stored ?? fetched.data?.explanation;
  const evidence = analysis.evidence[target] ?? fetched.data?.evidence;
  if (!explanation) {
    return (
      <p className="text-sm text-slate-500" data-testid="why-panel">
        {fetched.isError ? "Explanation unavailable." : `Loading the ${SHORT[target]} explanation…`}
      </p>
    );
  }
  const rows = showAll ? explanation.contributions : explanation.contributions.slice(0, 10);
  const max = Math.max(...explanation.contributions.map((c) => Math.abs(c.contribution)));
  const groups = Object.entries(explanation.groups).sort((a, b) => Math.abs(b[1].contribution) - Math.abs(a[1].contribution));
  const groupMax = Math.max(...groups.map(([, g]) => Math.abs(g.contribution)));

  return (
    <section aria-label={`Why: ${SHORT[target]}`} className="space-y-4" data-testid="why-panel">
      <header>
        <h2 className="text-sm font-bold tracking-wide text-slate-900" title={TOOLTIPS.how}>
          Why did the model predict this? · {SHORT[target]}
        </h2>
        <p className="mt-1 text-xs text-slate-600">{explanation.caption}</p>
      </header>

      <div>
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-500">By input group</h3>
        <ul className="space-y-1">
          {groups.map(([g, stat]) => (
            <li key={g} className="grid grid-cols-[8.5rem_1fr] items-center gap-2 text-xs">
              <span className="truncate text-slate-700">{GROUP_LABEL[g] ?? g}</span>
              <EffectBar c={stat} max={groupMax} />
            </li>
          ))}
        </ul>
      </div>

      <div>
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-500">
          Measurements and model contributions
        </h3>
        <p className="mb-1 text-[11px] text-slate-500">
          <span className="text-amber-700">■</span> pushed the {SHORT[target]} probability up ·{" "}
          <span className="text-sky-800">■</span> pushed it down (model contribution, not a cause)
        </p>
        <table className="w-full text-xs">
          <thead className="text-left text-[11px] text-slate-500">
            <tr>
              <th className="py-1 font-medium">Measurement</th>
              <th className="py-1 font-medium">Value</th>
              <th className="w-64 py-1 font-medium">Effect on the {SHORT[target]} estimate</th>
              <th className="py-1 text-right font-medium">Share</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.feature} className="border-t border-slate-100 align-top" title={comparisonText(c, target)}>
                <td className="py-1 pr-2 text-slate-800">
                  {c.display}
                  <div className="text-[10px] text-slate-500">{comparisonText(c, target)}</div>
                </td>
                <td className="py-1 pr-2 tabular-nums text-slate-700">
                  {c.display_value}
                  {c.value_status !== "provided" && (
                    <span className="ml-1 rounded bg-slate-100 px-1 text-[10px] text-slate-700">{c.value_status}</span>
                  )}
                </td>
                <td className="py-1.5 pr-2">
                  <EffectBar c={c} max={max} />
                </td>
                <td className="py-1 text-right tabular-nums text-slate-600">
                  {c.relative_share == null ? "—" : `${Math.round(c.relative_share * 100)}%`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {explanation.contributions.length > 10 && (
          <button type="button" className="mt-1 text-xs text-slate-600 underline" onClick={() => setShowAll(!showAll)}>
            {showAll ? "Show top 10" : `Show all ${explanation.contributions.length}`}
          </button>
        )}
      </div>

      {evidence && (
        <div>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-500">Evidence</h3>
          {(analysis.quality.notices ?? []).filter((notice) => notice.code === "legacy_oof_ledger_withheld").map((notice) => (
            <p key={notice.code} role="note" className="mb-1 text-xs text-amber-800">{notice.message}</p>
          ))}
          <p className="text-xs text-slate-700">
            {evidence.evidence_ledger.status === "ok"
              ? `Empirical positive-label rate in this public-dataset probability band (${pct(evidence.evidence_ledger.band[0]!)}–${pct(evidence.evidence_ledger.band[1]!)}): ${pct(evidence.evidence_ledger.positive_label_rate ?? 0)} (n = ${evidence.evidence_ledger.n})`
              : `Insufficient evidence in this probability band (n = ${evidence.evidence_ledger.n})`}
          </p>
          {evidence.stability_interval && (
            <p className="text-xs text-slate-700" data-testid="stability-interval"
               title="How much this probability moves when the model is refit on bootstrap resamples of its own training patients. It is a measure of model stability, not a confidence interval for the patient's true risk.">
              Model stability interval: {probPct(evidence.stability_interval.p10)}–{probPct(evidence.stability_interval.p90)}
              <span className="text-slate-500"> (10th–90th percentile of {evidence.stability_interval.n_valid} valid refits)</span>
            </p>
          )}
          <p className="mt-2 text-[11px] font-medium text-slate-600">
            {evidence.similar_patients.title} · {evidence.similar_patients.subtitle}
          </p>
          <ul className="mt-1 grid grid-cols-2 gap-x-3 text-[11px] text-slate-600">
            {evidence.similar_patients.patients.slice(0, 6).map((n) => (
              <li key={n.patient_id} className="tabular-nums">
                {n.patient_id} · d {n.distance.toFixed(2)} ·{" "}
                {target === "cad"
                  ? n.labels.cad ? "CAD label" : "no CAD label"
                  : `${SHORT[target]} ${n.labels[target] ? "stenotic" : "normal"}`}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
