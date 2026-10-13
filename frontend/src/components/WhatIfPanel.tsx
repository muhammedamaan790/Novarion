// Tier-3 what-if sensitivity (plan §6 Tier 3 "Re-predict edited mutable features within training range; Age/Sex
// locked; ICE curves" · wording "Model sensitivity, not treatment simulation") + input-uncertainty ("Inputs that
// materially affect this model output"). Final-model analyses only: dataset patients stay with their OOF model.
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type DisplayAnalysis, type Schemas, type TargetId } from "../api/client";
import { SHORT, probPct } from "./wording";

type Curve = Schemas["SensitivityCurve"];
const W = 150;
const H = 34;

function fmt(v: number | string): string {
  return typeof v === "number" ? String(Math.round(v * 100) / 100) : v;
}

function Sparkline({ curve, threshold }: { curve: Curve; threshold: number }) {
  const xs = curve.points.map((p) => Number(p.value));
  const [lo, hi] = [Math.min(...xs), Math.max(...xs)];
  const sx = (v: number) => (hi === lo ? W / 2 : 2 + ((v - lo) / (hi - lo)) * (W - 4));
  const sy = (p: number) => H - 2 - p * (H - 4);
  const path = curve.points.map((p, i) => `${i ? "L" : "M"}${sx(Number(p.value)).toFixed(1)},${sy(p.probability).toFixed(1)}`).join("");
  const cur = Number(curve.current_value);
  const label = `${curve.display}: probability from ${probPct(Math.min(...curve.points.map((p) => p.probability)))} to ${
    probPct(Math.max(...curve.points.map((p) => p.probability)))} across ${fmt(lo)}–${fmt(hi)}; current ${fmt(curve.current_value)}`;
  return (
    <svg width={W} height={H} role="img" aria-label={label} className="shrink-0">
      <rect x="0" y="0" width={W} height={H} fill="#f8fafc" />
      <line x1="0" x2={W} y1={sy(threshold)} y2={sy(threshold)} stroke="#64748b" strokeDasharray="3 3" strokeWidth="1" />
      <path d={path} fill="none" stroke="#2a78d6" strokeWidth="1.75" />
      {Number.isFinite(cur) && cur >= lo && cur <= hi && (
        <line x1={sx(cur)} x2={sx(cur)} y1="1" y2={H - 1} stroke="#0f172a" strokeWidth="1.5" />
      )}
    </svg>
  );
}

function CategoryValues({ curve }: { curve: Curve }) {
  return (
    <span className="text-[11px] tabular-nums text-slate-700">
      {curve.points.map((p) => (
        <span key={String(p.value)}
              className={`mr-2 inline-block whitespace-nowrap ${p.value === curve.current_value ? "font-semibold text-slate-900" : ""}`}>
          {curve.kind === "binary" ? (p.value === 1 ? "yes" : "no") : String(p.value)}: {probPct(p.probability)}
        </span>
      ))}
    </span>
  );
}

export function WhatIfPanel({ analysis, target, initiallyOpen = false }: {
  analysis: DisplayAnalysis; target: TargetId; initiallyOpen?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const [showAll, setShowAll] = useState(false);
  const finalModel = analysis.patient.prediction_mode === "final_model";
  const query = useQuery({
    queryKey: ["sensitivity", analysis.analysis_id, target],
    queryFn: async () => (await api.sensitivity(analysis, target)).data,
    enabled: open && finalModel, staleTime: Infinity, retry: false,
  });
  const s = query.data;
  const curves = s ? (showAll ? s.curves : s.curves.slice(0, 6)) : [];
  return (
    <div data-testid="whatif">
      <button type="button" className="text-xs font-semibold uppercase tracking-wider text-slate-500 hover:text-slate-800"
              aria-expanded={open} onClick={() => setOpen((v) => !v)} data-testid="whatif-toggle">
        {open ? "▾" : "▸"} What-if sensitivity · {SHORT[target]}
      </button>
      {open && !finalModel && (
        <p className="mt-1 text-[11px] text-slate-600">
          This dataset patient is shown with the out-of-fold model that never saw them. What-if uses the deployed model,
          so explore it on a new case: New case → Prefill from this patient.
        </p>
      )}
      {open && finalModel && (
        <div className="mt-1 space-y-1.5">
          <p className="rounded bg-sky-50 p-1.5 text-[11px] text-sky-900">
            <b>Model sensitivity, not treatment simulation.</b> One input at a time is varied across the range seen in
            training, all others held fixed; age and sex are never varied. The dashed line is the decision threshold;
            the dark tick is this case.
          </p>
          {query.isPending && <p className="text-[11px] text-slate-500">Computing sensitivity…</p>}
          {query.isError && (
            <p className="text-[11px] text-slate-600">
              Not available for this analysis (it must come from the currently deployed model; re-analyze a stored case first).
            </p>
          )}
          {s && s.material_unknown_inputs.length > 0 && (
            <p className="rounded bg-amber-50 p-1.5 text-[11px] text-amber-900" data-testid="whatif-material">
              Inputs that materially affect this model output:{" "}
              {s.material_unknown_inputs.map((f) => s.curves.find((c) => c.feature === f)?.display ?? f).join(", ")}{" "}
              (marked Unknown; a measured value could change the predicted class). Clinical next steps are determined by
              the treating clinician.
            </p>
          )}
          {s && (
            <ul className="space-y-1">
              {curves.map((c) => (
                <li key={c.feature} className="flex items-center gap-2 text-[11px]" data-testid={`whatif-${c.feature}`}>
                  <span className="w-32 shrink-0 truncate text-slate-700" title={c.display}>
                    {c.display}
                    {c.current_status === "imputed" && <span className="text-amber-800"> (unknown)</span>}
                  </span>
                  {c.kind === "continuous" ? <Sparkline curve={c} threshold={s.operating_threshold} /> : <CategoryValues curve={c} />}
                  <span className="ml-auto shrink-0 tabular-nums text-slate-600">
                    {Math.round(c.swing * 100)}-pt range{c.class_changes ? " · can flip class" : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {s && s.curves.length > 6 && (
            <button type="button" className="text-[11px] text-slate-600 underline" onClick={() => setShowAll((v) => !v)}>
              {showAll ? "Show top 6" : `Show all ${s.curves.length} inputs`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
