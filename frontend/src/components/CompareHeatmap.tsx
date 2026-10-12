// State 5 "Compare all vessels" (plan §9.2, §8 "State 5 shows a features × {CAD, LAD, LCX, RCA} contribution
// heatmap"). Diverging encoding: amber = pushed that model's probability up, blue = pushed it down, depth = size of the
// calibrated log-odds contribution. Every cell also carries an arrow + strength word (identity never colour-only).
import { useQueries } from "@tanstack/react-query";
import { TARGET_IDS, type Contribution, type DisplayAnalysis, type ExplanationPayload, type TargetId } from "../api/client";
import { explainQuery } from "../api/queries";
import { SHORT } from "./wording";

const TOP_N = 15;

function cellStyle(c: number, max: number): React.CSSProperties {
  const t = max === 0 ? 0 : Math.min(1, Math.abs(c) / max);
  const alpha = 0.08 + 0.72 * Math.sqrt(t); // sqrt: small contributions stay visible but recessive
  return { background: c > 0 ? `rgba(217, 119, 6, ${alpha})` : c < 0 ? `rgba(3, 105, 161, ${alpha})` : "#f8fafc",
           color: t > 0.55 ? "#ffffff" : "#1e293b" };
}

export function CompareHeatmap({ analysis }: { analysis: DisplayAnalysis }) {
  const fetched = useQueries({ queries: TARGET_IDS.map((t) => explainQuery(analysis, t)) });
  const explanations: Partial<Record<TargetId, ExplanationPayload>> = {};
  TARGET_IDS.forEach((t, i) => {
    const e = analysis.explanations[t] ?? fetched[i]?.data?.explanation;
    if (e) explanations[t] = e;
  });
  if (TARGET_IDS.some((t) => !explanations[t])) {
    const failed = fetched.some((q) => q.isError);
    return (
      <p className={`text-sm ${failed ? "text-red-700" : "text-slate-500"}`} data-testid="compare-panel">
        {failed ? "Explanations unavailable for this analysis." : "Loading explanations for all targets…"}
      </p>
    );
  }

  const byFeature = new Map<string, Partial<Record<TargetId, Contribution>>>();
  for (const t of TARGET_IDS) {
    for (const c of explanations[t]!.contributions) {
      byFeature.set(c.feature, { ...byFeature.get(c.feature), [t]: c });
    }
  }
  const strongest = (row: Partial<Record<TargetId, Contribution>>) =>
    Math.max(...TARGET_IDS.map((t) => Math.abs(row[t]?.contribution ?? 0)));
  const rows = [...byFeature.entries()].sort((a, b) => strongest(b[1]) - strongest(a[1]) || a[0].localeCompare(b[0]));
  const shown = rows.slice(0, TOP_N);
  const max = Math.max(...rows.map(([, r]) => strongest(r)));

  return (
    <section aria-label="Compare all targets" className="space-y-2" data-testid="compare-panel">
      <header>
        <h2 className="text-sm font-bold tracking-wide text-slate-900">Compare all targets · model contributions</h2>
        <p className="text-xs text-slate-600">
          Which measurements moved each model, side by side. Four independent models: the same measurement can push one
          target up and another down.
        </p>
        <p className="mt-1 text-[11px] text-slate-500">
          <span className="font-semibold text-amber-700">↑ amber</span> pushed that probability up ·{" "}
          <span className="font-semibold text-sky-800">↓ blue</span> pushed it down · colour depth = size of the model
          contribution (calibrated log-odds) · associations learned from this cohort, not causes
        </p>
      </header>
      <table className="w-full table-fixed text-[11px]">
        <thead>
          <tr className="text-left text-slate-500">
            <th className="w-[38%] py-1 font-medium">Measurement</th>
            <th className="w-[18%] font-medium">Value</th>
            {TARGET_IDS.map((t) => <th key={t} className="text-center font-semibold text-slate-700">{SHORT[t]}</th>)}
          </tr>
        </thead>
        <tbody>
          {shown.map(([feature, row]) => {
            const any = TARGET_IDS.map((t) => row[t]).find(Boolean)!;
            return (
              <tr key={feature} className="border-t border-white">
                <td className="truncate py-0.5 pr-1 text-slate-800" title={any.display}>{any.display}</td>
                <td className="truncate pr-1 tabular-nums text-slate-600" title={any.display_value}>{any.display_value}</td>
                {TARGET_IDS.map((t) => {
                  const c = row[t];
                  if (!c) return <td key={t} className="bg-slate-50 text-center text-slate-500" title="not used by this model">–</td>;
                  const label = `${SHORT[t]} · ${any.display}: ${c.direction === "up" ? "pushed up" : c.direction === "down"
                    ? "pushed down" : "no effect"} (${c.strength}, ${c.contribution >= 0 ? "+" : ""}${c.contribution.toFixed(2)} calibrated log-odds)`;
                  return (
                    <td key={t} className="px-0.5 py-0.5 text-center tabular-nums" style={cellStyle(c.contribution, max)}
                        title={label} aria-label={label}>
                      {c.direction === "up" ? "↑" : c.direction === "down" ? "↓" : "·"}{" "}
                      <span className="text-[9px]">{c.strength === "strong" ? "strong" : c.strength === "moderate" ? "mod." : "slight"}</span>
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length > TOP_N && (
        <p className="text-[11px] text-slate-500">
          Top {TOP_N} of {rows.length} measurements by their largest contribution to any target. Select a vessel to see its full
          breakdown with cohort comparisons.
        </p>
      )}
    </section>
  );
}
