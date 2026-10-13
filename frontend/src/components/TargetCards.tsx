// CAD card + three vessel cards (plan §12, Screen 2 right column). Clicking a card = selectTarget (same as 3D).
import { TARGET_IDS, type DisplayAnalysis, type Meta, type TargetId, type TargetPrediction } from "../api/client";
import { vesselColor, type ColorTransfer } from "../three/colors";
import { useStore } from "../store/useStore";
import { REASON_TEXT, SHORT, TOOLTIPS, pct, predictionText, probPct, probabilityLabel, subtitle } from "./wording";

function ConfidenceBlock({ p }: { p: TargetPrediction }) {
  if (p.model_confidence === "high") {
    const ev = p.evaluation_context;
    return (
      <div className="mt-2 text-xs" title={TOOLTIPS.confidence}>
        <span className="rounded bg-slate-800 px-1.5 py-0.5 font-semibold tracking-wide text-white">
          HIGH MODEL CONFIDENCE
        </span>
        {ev && (
          <p className="mt-1 text-slate-600">
            Threshold-region evaluation {ev.metric.toUpperCase()} {pct(ev.value)}
            {ev.ci ? ` (95% CI ${pct(ev.ci[0]!)}–${pct(ev.ci[1]!)})` : ""}, before input-quality gates.
            {" "}Qualification uses training-side validation.
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="mt-2 text-xs" title={TOOLTIPS.confidence}>
      <span className="rounded border border-dashed border-slate-500 px-1.5 py-0.5 font-semibold tracking-wide text-slate-700">
        LOW MODEL CONFIDENCE
      </span>
      <p className="mt-1 text-slate-600">
        This prediction does not meet all HIGH-confidence requirements. Reason:{" "}
        {p.model_confidence_reasons.map((r) => REASON_TEXT[r] ?? r).join("; ")}.
      </p>
    </div>
  );
}

/** Advanced stability visual (plan Tier 3): the refit-bootstrap 10th–90th percentile band against the threshold. */
function StabilityBar({ p }: { p: TargetPrediction }) {
  const s = p.stability_interval;
  if (!s) return null;
  const straddles = s.p10 < p.operating_threshold && p.operating_threshold <= s.p90;
  const x = (v: number) => `${(v * 100).toFixed(1)}%`;
  return (
    <div className="mt-1.5" data-testid="stability-bar"
         title="Model stability interval: how much this probability moves when the model is refit on bootstrap resamples of its own training patients (10th–90th percentile). Not a confidence interval for the patient's true risk.">
      <div className="relative h-2 rounded-full bg-slate-100" role="img"
           aria-label={`Model stability interval ${probPct(s.p10)} to ${probPct(s.p90)}; decision threshold ${probPct(p.operating_threshold)}${straddles ? "; the interval straddles the threshold" : ""}`}>
        <div className={`absolute inset-y-0 rounded-full ${straddles ? "bg-amber-400" : "bg-slate-400"}`}
             style={{ left: x(s.p10), width: x(Math.max(s.p90 - s.p10, 0.004)) }} />
        <div className="absolute -inset-y-0.5 w-0.5 bg-slate-900" style={{ left: x(p.probability) }} />
        <div className="absolute -inset-y-1 border-l border-dashed border-slate-500" style={{ left: x(p.operating_threshold) }} />
      </div>
      <p className="mt-0.5 text-[10px] text-slate-500">
        Stability {probPct(s.p10)}–{probPct(s.p90)} · threshold {probPct(p.operating_threshold)}
        {straddles ? " · crosses the threshold" : ""}
      </p>
    </div>
  );
}

const reasonsText = (p: TargetPrediction) => p.model_confidence_reasons.map((r) => REASON_TEXT[r] ?? r).join("; ");
// Reasons that come from this patient's inputs stay visible when collapsed: the user can act on them.
const INPUT_REASONS = new Set(["unknown_input", "atypical_profile"]);

/** One line per target; the selected card expands to its stability and confidence detail (progressive disclosure). */
function Card({ target, p, transfer }: { target: TargetId; p: TargetPrediction; transfer: ColorTransfer }) {
  const selected = useStore((s) => s.selectedTarget === target);
  const selectTarget = useStore((s) => s.selectTarget);
  const color = vesselColor(transfer, p.probability, p.operating_threshold, p.model_confidence === "low");
  const low = p.model_confidence === "low";
  const actionable = low ? p.model_confidence_reasons.filter((r) => INPUT_REASONS.has(r)) : [];
  return (
    <button
      type="button"
      onClick={() => selectTarget(selected ? null : target)}
      aria-pressed={selected}
      data-testid={`card-${target}`}
      className={`w-full rounded-lg border bg-white px-3 py-2 text-left transition-shadow ${
        selected ? "border-slate-900 shadow-md" : "border-slate-200 hover:shadow-sm"
      }`}
    >
      <div className="flex items-center gap-2">
        <span
          className={`h-3 w-3 shrink-0 rounded-full ${low ? "ring-1 ring-dashed ring-slate-500" : ""}`}
          style={{ background: target === "cad" ? "transparent" : color.hex, border: target === "cad" ? "2px solid #475569" : undefined }}
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate text-[13px] font-bold tracking-wide text-slate-900">
          {target === "cad" ? "" : `${SHORT[target]} · `}
          {predictionText(target, p)}
        </span>
        <span className="text-sm font-semibold tabular-nums text-slate-800"
              title={target === "cad" ? TOOLTIPS.overallCad : TOOLTIPS.vessel}>
          {probPct(p.probability)}
        </span>
        <span className="text-xs text-slate-500" aria-hidden>{selected ? "▾" : "▸"}</span>
      </div>
      {!selected && (
        <p className="ml-5 mt-1 text-[10px]" title={low ? `Reason: ${reasonsText(p)}. ${TOOLTIPS.confidence}` : TOOLTIPS.confidence}>
          <span className={`rounded px-1 py-px font-semibold tracking-wide ${
            low ? "border border-dashed border-slate-400 text-slate-600" : "bg-slate-800 text-white"}`}>
            {low ? "LOW" : "HIGH"} MODEL CONFIDENCE
          </span>
          {actionable.length > 0 && (
            <span className="ml-1.5 text-slate-700">{actionable.map((r) => REASON_TEXT[r] ?? r).join("; ")}</span>
          )}
        </p>
      )}
      {selected && (
        <div className="ml-5">
          <p className="mt-0.5 text-[11px] italic text-slate-500">{subtitle(target)}</p>
          <p className="mt-1 text-xs text-slate-700" title={target === "cad" ? TOOLTIPS.overallCad : TOOLTIPS.vessel}>
            {probabilityLabel(target)} <span className="font-semibold tabular-nums">{probPct(p.probability)}</span>
          </p>
          <StabilityBar p={p} />
          <ConfidenceBlock p={p} />
        </div>
      )}
    </button>
  );
}

/** The whole picture in two lines, so the four cards don't have to be read and added up. */
export function Summary({ analysis, testId = "verdict-summary" }: { analysis: DisplayAnalysis; testId?: string }) {
  const preds = TARGET_IDS.flatMap((t) => (analysis.targets[t] ? [[t, analysis.targets[t]!] as const] : []));
  const cad = analysis.targets.cad;
  const stenosed = preds.filter(([t, p]) => t !== "cad" && p.predicted_class === "positive").map(([t]) => SHORT[t]);
  const lowTargets = preds.filter(([, p]) => p.model_confidence === "low").map(([t]) => SHORT[t]);
  const cadText = cad ? (cad.predicted_class === "positive" ? "CAD predicted" : "No CAD predicted") : "";
  const vesselText = stenosed.length ? `stenosis predicted in ${stenosed.join(", ")}` : "no vessel stenosis predicted";
  const confidenceText = lowTargets.length === 0 ? "All predictions: HIGH model confidence"
    : lowTargets.length === preds.length ? `All ${preds.length} predictions: LOW model confidence`
      : `LOW model confidence: ${lowTargets.join(", ")}`;
  return (
    <div className="rounded-lg bg-slate-50 p-3" data-testid={testId}>
      <p className="text-base font-bold text-slate-900" title={TOOLTIPS.independence}>{cadText} · {vesselText}</p>
      <p className={`mt-0.5 text-sm font-semibold ${lowTargets.length ? "text-amber-800" : "text-slate-700"}`} title={TOOLTIPS.confidence}>
        {confidenceText}
      </p>
    </div>
  );
}

export function TargetCards({ analysis, meta }: { analysis: DisplayAnalysis | null; meta: Meta }) {
  const transfer = (meta.anatomy_map as { color_transfer: ColorTransfer }).color_transfer;
  if (!analysis) {
    return (
      <div className="space-y-2" aria-busy>
        {TARGET_IDS.map((t) => (
          <div key={t} className="h-24 animate-pulse rounded-lg border border-slate-200 bg-slate-100 motion-reduce:animate-none" />
        ))}
      </div>
    );
  }
  return (
    <section aria-label="Predictions" className="space-y-2" data-testid="predictions" data-input-sha256={analysis.input_sha256}>
      <Summary analysis={analysis} />
      {(analysis.quality.notices ?? []).map((notice) => (
        <p key={notice.code} role="note" className="rounded bg-amber-50 p-2 text-[11px] text-amber-900">
          {notice.message}
        </p>
      ))}
      {TARGET_IDS.map((t) => {
        const p = analysis.targets[t];
        return p ? <Card key={t} target={t} p={p} transfer={transfer} /> : null; // App commits only complete analyses
      })}

    </section>
  );
}
