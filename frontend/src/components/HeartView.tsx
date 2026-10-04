// Centre column: 3D canvas + overlays (accessible selection buttons, legend, tooltip, notices). Plan §9.2, §12.
import { useCallback, useRef } from "react";
import { VESSELS, TARGET_IDS, type DisplayAnalysis, type Meta, type TargetId } from "../api/client";
import { HeartScene, LABELLED_TARGETS, nodeToTarget, type AnatomyMap } from "../three/HeartScene";
import { rampColor } from "../three/colors";
import { useStore } from "../store/useStore";
import { SHORT, TOOLTIPS, pct, predictionText } from "./wording";

function Legend({ map }: { map: AnatomyMap }) {
  const ramp = (family: "warm" | "cool") =>
    [0, 0.25, 0.5, 0.75, 1].map((i) => rampColor(map.color_transfer, family, i, false).hex);
  return (
    <div className="pointer-events-auto rounded-md bg-white/90 p-2 text-[10px] text-slate-600 shadow-sm" title={TOOLTIPS.legend}>
      {(["warm", "cool"] as const).map((family) => (
        <div key={family} className="flex items-center gap-1.5">
          <span className="flex">
            {ramp(family).map((hex) => (
              <span key={hex} className="h-2.5 w-4" style={{ background: hex }} />
            ))}
          </span>
          {family === "warm" ? "stenosis predicted" : "no stenosis predicted"}
        </div>
      ))}
      <div className="mt-0.5 flex items-center gap-1.5">
        <span className="h-2.5 w-20 border border-dashed border-slate-500 bg-[repeating-linear-gradient(45deg,#cbd5e1_0_3px,#ffffff_3px_6px)]" />
        low model confidence (desaturated, hatched)
      </div>
      <p className="mt-1 max-w-56 leading-tight">{TOOLTIPS.legend}</p>
    </div>
  );
}

function Tooltip({ analysis, map }: { analysis: DisplayAnalysis | null; map: AnatomyMap }) {
  const hover = useStore((s) => s.hover);
  if (!hover) return null;
  const target = nodeToTarget(map)[hover.node];
  let text = map.non_target_nodes[hover.node]?.message ?? "";
  if (target) {
    const p = analysis?.targets[target];
    text = p
      ? `${target === "cad" ? "Heart · overall CAD" : SHORT[target]} · ${predictionText(target, p)} · ${pct(p.probability)} · ${
          p.model_confidence === "high" ? "HIGH" : "LOW"
        } MODEL CONFIDENCE`
      : `${map.targets[target].label} · no analysis loaded`;
  }
  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute z-20 max-w-xs rounded bg-slate-900/90 px-2 py-1 text-[11px] text-white"
      style={{ left: hover.x + 14, top: hover.y + 14 }}
    >
      {text}
    </div>
  );
}

export function HeartView({ meta, analysis }: { meta: Meta; analysis: DisplayAnalysis | null }) {
  const map = meta.anatomy_map as unknown as AnatomyMap;
  const selectedTarget = useStore((s) => s.selectedTarget);
  const isolation = useStore((s) => s.isolation);
  const notice = useStore((s) => s.notice);
  const { selectTarget, toggleIsolation } = useStore.getState();
  const labels = useRef<Partial<Record<TargetId, HTMLElement | null>>>({});
  const placeLabel = useCallback((target: TargetId, x: number, y: number, visible: boolean) => {
    const el = labels.current[target];
    if (!el) return;
    el.style.transform = `translate(-50%, -150%) translate(${x}px, ${y}px)`;
    el.style.visibility = visible ? "visible" : "hidden";
  }, []);

  return (
    <div className="relative h-full min-h-[420px] overflow-hidden rounded-lg border border-slate-200 bg-[#f4f5f7]">
      <HeartScene meta={meta} analysis={analysis} placeLabel={placeLabel} />
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
        {LABELLED_TARGETS.map((t) => (
          <span
            key={t}
            ref={(el) => {
              labels.current[t] = el;
            }}
            style={{ visibility: "hidden" }}
            className={`absolute left-0 top-0 rounded px-1.5 py-0.5 text-[11px] font-semibold tracking-wide shadow-sm ${
              selectedTarget === t
                ? "bg-slate-900 text-white"
                : selectedTarget
                  ? "bg-white/60 text-slate-500" // recede while another target is inspected
                  : "bg-white/85 text-slate-800"
            }`}
          >
            {map.targets[t].label}
          </span>
        ))}
      </div>
      <Tooltip analysis={analysis} map={map} />

      <div className="pointer-events-none absolute inset-x-2 top-2 flex flex-wrap items-start justify-between gap-2">
        <div className="pointer-events-auto flex flex-wrap gap-1" role="group" aria-label="Select prediction target">
          {TARGET_IDS.map((t) => (
            <button
              key={t}
              type="button"
              aria-pressed={selectedTarget === t}
              aria-label={`Select ${t === "cad" ? "overall CAD" : SHORT[t]}`}
              data-testid={`select-${t}`}
              onClick={() => selectTarget(selectedTarget === t ? null : t)}
              className={`rounded px-2 py-1 text-xs font-semibold shadow-sm ${
                selectedTarget === t ? "bg-slate-900 text-white" : "bg-white text-slate-700 hover:bg-slate-50"
              }`}
            >
              {t === "cad" ? "Heart · CAD" : SHORT[t]}
              <span className="ml-1 font-normal opacity-60">{t === "cad" ? 0 : VESSELS.indexOf(t) + 1}</span>
            </button>
          ))}
          <button
            type="button"
            onClick={() => selectTarget(null)}
            className="rounded bg-white px-2 py-1 text-xs text-slate-600 shadow-sm hover:bg-slate-50"
          >
            Reset <span className="opacity-60">Esc</span>
          </button>
        </div>
        <label className="pointer-events-auto flex items-center gap-1 rounded bg-white px-2 py-1 text-xs text-slate-600 shadow-sm">
          <input type="checkbox" checked={isolation} onChange={toggleIsolation} /> Isolate selected vessel
        </label>
      </div>

      {!analysis && (
        <p className="pointer-events-none absolute inset-x-0 top-14 text-center text-xs text-slate-500">
          Anatomy shown in neutral grey until a complete analysis is loaded.
        </p>
      )}
      {notice && (
        <p role="status" className="absolute inset-x-0 top-14 mx-auto w-fit rounded bg-white px-3 py-1 text-xs text-slate-700 shadow">
          {notice}
        </p>
      )}

      <div className="pointer-events-auto absolute right-2 top-12 flex flex-col gap-1" role="group" aria-label="Camera view">
        {(map.view_presets ?? []).map((v) => (
          <button
            key={v.id}
            type="button"
            onClick={() => useStore.getState().setViewPreset(v.id)}
            data-testid={`view-${v.id}`}
            className="rounded bg-white/90 px-2 py-0.5 text-[11px] text-slate-600 shadow-sm hover:bg-white"
          >
            {v.label}
          </button>
        ))}
      </div>

      <div className="pointer-events-none absolute bottom-2 left-2">
        <Legend map={map} />
      </div>
      <p className="pointer-events-none absolute bottom-2 right-2 max-w-60 text-right text-[10px] leading-tight text-slate-500">
        Reference anatomy (BodyParts3D, CC BY 4.0), not a patient-specific reconstruction. Each vessel is tinted as a
        whole; location within the vessel is not known.
      </p>
    </div>
  );
}
