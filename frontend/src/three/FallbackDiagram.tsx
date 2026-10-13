// Emergency 2D coronary schematic (plan §9.5): shown ONLY when WebGL is unavailable. Driven by the same store, the same
// TargetIds and the same colour transfer function as the 3D view — never the advertised visualization.
import type { DisplayAnalysis, TargetId } from "../api/client";
import { SHORT, probPct } from "../components/wording";
import type { SceneState } from "./sceneState";
import { NEUTRAL_LINEAR, linearToHex, vesselColor, type ColorTransfer } from "./colors";

const PATHS: Record<"lad" | "lcx" | "rca", string> = {
  lad: "M 205 95 C 215 150 215 210 200 290",            // anterior interventricular groove
  lcx: "M 205 95 C 250 100 285 130 290 185 C 292 215 280 240 262 255", // left AV groove
  rca: "M 190 98 C 145 100 112 135 108 185 C 106 225 125 255 160 270", // right AV groove
};
const LABEL_AT: Record<"lad" | "lcx" | "rca", [number, number]> = { lad: [214, 200], lcx: [298, 170], rca: [60, 175] };

export function FallbackDiagram({ analysis, transfer, sceneState }: {
  analysis: DisplayAnalysis | null; transfer: ColorTransfer; sceneState: SceneState;
}) {
  const selected = sceneState.selected;
  const selectTarget = sceneState.select;
  const tid = (id: string) => (sceneState.kind === "anatomy" ? `anatomy-${id}` : id);
  const colour = (t: TargetId) => {
    const p = analysis?.targets[t];
    return p ? vesselColor(transfer, p.probability, p.operating_threshold, p.model_confidence === "low").hex
      : linearToHex(NEUTRAL_LINEAR);
  };
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-4" data-testid={tid("fallback-2d")}>
      <p role="status" className="max-w-md rounded bg-amber-50 px-3 py-1.5 text-center text-xs text-amber-900">
        3D graphics (WebGL) are not available in this browser, so a simplified 2D schematic is shown. Predictions,
        explanations and all other features work normally.
      </p>
      <svg viewBox="0 0 400 340" className="h-full max-h-[460px] w-full" role="img"
           aria-label="2D coronary schematic: LAD, LCX and RCA coloured by their predictions">
        <path d="M 200 80 C 120 70 70 140 80 210 C 92 280 160 320 205 318 C 265 316 320 260 318 190 C 316 120 270 70 200 80 Z"
              fill="#d8b4b4" stroke="#94a3b8" onClick={() => selectTarget("cad")} className="cursor-pointer" />
        {(Object.keys(PATHS) as ("lad" | "lcx" | "rca")[]).map((t) => (
          <g key={t} onClick={() => selectTarget(selected === t ? null : t)} className="cursor-pointer"
             role="button" aria-label={`Select ${SHORT[t]}`} aria-pressed={selected === t} data-testid={tid(`fallback-${t}`)}>
            <path d={PATHS[t]} fill="none" stroke="transparent" strokeWidth={18} />
            <path d={PATHS[t]} fill="none" stroke={colour(t)} strokeWidth={selected === t ? 9 : 6} strokeLinecap="round"
                  strokeDasharray={analysis?.targets[t]?.model_confidence === "low" ? "10 5" : undefined} />
            <text x={LABEL_AT[t][0]} y={LABEL_AT[t][1]} className="fill-slate-800 text-[13px] font-semibold">
              {SHORT[t]}{analysis?.targets[t] ? ` ${probPct(analysis.targets[t]!.probability)}` : ""}
            </text>
          </g>
        ))}
      </svg>
      <p className="text-[11px] text-slate-600">Schematic only; dashed = standard confidence. Each vessel is tinted as a whole.</p>
    </div>
  );
}

/** True when the browser can create a WebGL context (checked once, before mounting the 3D canvas). */
export function webglAvailable(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return !!(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    return false;
  }
}
