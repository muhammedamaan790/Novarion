// CAD card + three vessel cards (plan §12, Screen 2 right column). Clicking a card = selectTarget (same as 3D).
import { TARGET_IDS, type DisplayAnalysis, type Meta, type TargetId, type TargetPrediction } from "../api/client";
import { vesselColor, type ColorTransfer } from "../three/colors";
import { useStore } from "../store/useStore";
import { REASON_TEXT, SHORT, TOOLTIPS, pct, predictionText, probabilityLabel, subtitle } from "./wording";

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

function Card({ target, p, transfer }: { target: TargetId; p: TargetPrediction; transfer: ColorTransfer }) {
  const selected = useStore((s) => s.selectedTarget === target);
  const selectTarget = useStore((s) => s.selectTarget);
  const color = vesselColor(transfer, p.probability, p.operating_threshold, p.model_confidence === "low");
  return (
    <button
      type="button"
      onClick={() => selectTarget(selected ? null : target)}
      aria-pressed={selected}
      data-testid={`card-${target}`}
      className={`w-full rounded-lg border bg-white p-3 text-left transition-shadow ${
        selected ? "border-slate-900 shadow-md" : "border-slate-200 hover:shadow-sm"
      }`}
    >
      <div className="flex items-center gap-2">
        <span
          className={`h-3 w-3 shrink-0 rounded-full ${p.model_confidence === "low" ? "ring-1 ring-dashed ring-slate-500" : ""}`}
          style={{ background: target === "cad" ? "transparent" : color.hex, border: target === "cad" ? "2px solid #475569" : undefined }}
          aria-hidden
        />
        <span className="text-sm font-bold tracking-wide text-slate-900">
          {target === "cad" ? "" : `${SHORT[target]} · `}
          {predictionText(target, p)}
        </span>
      </div>
      <p className="mt-0.5 text-[11px] italic text-slate-500">{subtitle(target)}</p>
      <p className="mt-2 text-sm text-slate-700" title={target === "cad" ? TOOLTIPS.overallCad : TOOLTIPS.vessel}>
        {probabilityLabel(target)} <span className="font-semibold tabular-nums">{pct(p.probability)}</span>
      </p>
      <ConfidenceBlock p={p} />
    </button>
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
      <p className="text-[11px] text-slate-500" title={TOOLTIPS.independence}>
        Four independent models · probabilities are not constrained to nest ⓘ
      </p>
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
