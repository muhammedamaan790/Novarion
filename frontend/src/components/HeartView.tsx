// Centre column: 3D canvas + overlays (accessible selection buttons, legend, tooltip, notices). Plan §9.2, §12.
import { useCallback, useRef, useState } from "react";
import { VESSELS, TARGET_IDS, type DisplayAnalysis, type Meta, type TargetId } from "../api/client";
import { FallbackDiagram, webglAvailable } from "../three/FallbackDiagram";
import { HeartScene, LABELLED_TARGETS, nodeToTarget, type AnatomyMap } from "../three/HeartScene";
import { rampColor } from "../three/colors";
import { useStore } from "../store/useStore";
import { SHORT, TOOLTIPS, predictionText, probPct } from "./wording";

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
      ? `${target === "cad" ? "Heart · overall CAD" : SHORT[target]} · ${predictionText(target, p)} · ${probPct(p.probability)} · ${
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
  const showBody = useStore((s) => s.showBody);
  const notice = useStore((s) => s.notice);
  const view = useStore((s) => s.view);
  const { selectTarget, toggleIsolation } = useStore.getState();
  const labels = useRef<Partial<Record<TargetId, HTMLElement | null>>>({});
  const [glAvailable] = useState(webglAvailable);
  const [contextLost, setContextLost] = useState(false);
  const [canvasKey, setCanvasKey] = useState(0);
  const placeLabel = useCallback((target: TargetId, x: number, y: number, visible: boolean) => {
    const el = labels.current[target];
    if (!el) return;
    el.style.transform = `translate(-50%, -150%) translate(${x}px, ${y}px)`;
    el.style.visibility = visible ? "visible" : "hidden";
  }, []);

  return (
    <div className="relative h-full min-h-[420px] overflow-hidden rounded-lg border border-slate-200 bg-[#f4f5f7]">
      {glAvailable ? (
        <HeartScene key={canvasKey} meta={meta} analysis={analysis} placeLabel={placeLabel}
                    onContextLost={() => setContextLost(true)} />
      ) : (
        <FallbackDiagram analysis={analysis} transfer={map.color_transfer} />
      )}
      {contextLost && (
        <div role="alert" data-testid="context-lost"
             className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-2 bg-white/85 text-sm text-slate-700">
          <p>The 3D view was paused because the graphics context was lost (e.g. a GPU reset).</p>
          <p className="text-xs text-slate-500">Predictions and panels are unaffected.</p>
          <button type="button" data-testid="restore-3d" className="rounded bg-slate-900 px-3 py-1 text-xs font-semibold text-white"
                  onClick={() => { setContextLost(false); setCanvasKey((k) => k + 1); }}>
            Restore 3D
          </button>
        </div>
      )}
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
            {view === "compare" && analysis?.targets[t]
              ? `${map.targets[t].label} · ${probPct(analysis.targets[t]!.probability)} · ${
                  analysis.targets[t]!.predicted_class === "positive" ? "stenosis" : "no stenosis"} · ${
                  analysis.targets[t]!.model_confidence === "high" ? "HIGH" : "LOW"}`
              : map.targets[t].label}
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
              <span className={`ml-1 font-normal ${selectedTarget === t ? "text-slate-300" : "text-slate-500"}`}>
                {t === "cad" ? 0 : VESSELS.indexOf(t) + 1}
              </span>
            </button>
          ))}
          <button
            type="button"
            onClick={() => useStore.getState().showCompare()}
            aria-pressed={view === "compare"}
            data-testid="compare-all"
            className={`rounded px-2 py-1 text-xs font-semibold shadow-sm ${
              view === "compare" ? "bg-slate-900 text-white" : "bg-white text-slate-700 hover:bg-slate-50"
            }`}
          >
            Compare all <span className={`font-normal ${view === "compare" ? "text-slate-300" : "text-slate-500"}`}>C</span>
          </button>
          <button
            type="button"
            onClick={() => selectTarget(null)}
            className="rounded bg-white px-2 py-1 text-xs text-slate-600 shadow-sm hover:bg-slate-50"
          >
            Reset <span className="text-slate-500">Esc</span>
          </button>
        </div>
        <div className="pointer-events-auto flex gap-1">
          <label className="flex items-center gap-1 rounded bg-white px-2 py-1 text-xs text-slate-600 shadow-sm">
            <input type="checkbox" checked={showBody} onChange={() => useStore.getState().toggleBody()}
                   data-testid="toggle-body" /> Body context
          </label>
          <label className="flex items-center gap-1 rounded bg-white px-2 py-1 text-xs text-slate-600 shadow-sm">
            <input type="checkbox" checked={isolation} onChange={toggleIsolation} /> Isolate selected vessel
          </label>
        </div>
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

      <div className="pointer-events-none absolute bottom-14 left-2 sm:bottom-2">
        <Legend map={map} />
      </div>
      <p className="absolute inset-x-2 bottom-2 text-left text-[10px] leading-tight text-slate-600 sm:left-auto sm:text-right"
         title="Reference anatomy (BodyParts3D, CC BY 4.0), not a patient-specific reconstruction. Each vessel is tinted as a whole; location within the vessel is not known.">
        Reference anatomy, not this patient's · whole-vessel tint ⓘ
      </p>
    </div>
  );
}
