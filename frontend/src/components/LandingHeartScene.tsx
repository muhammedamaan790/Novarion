// The landing page's explorable heart (D-031, D-036): the app's own 3D scene with no patient. Fully controlled by
// LandingHeart: the selection, the tour and every callback live there, and this scene never touches the app store, so
// exploring here cannot change a signed-in workspace. Loaded on demand, so the 3D engine is not part of the landing
// page's first download. Clicking a vessel or its label selects it; drag rotates; zoom is deliberate (Ctrl/Cmd +
// wheel, pinch once 3D exploring is switched on, or the zoom buttons), so the page keeps scrolling over the heart.
import { useCallback, useEffect, useMemo, useRef, type MutableRefObject } from "react";
import type { Meta, TargetId } from "../api/client";
// The committed anatomy map (the API serves this same file); bundled into this on-demand chunk, so the landing page
// needs neither the API (which requires a session) nor the offline export (absent on hosted builds).
import anatomyMap from "../../../config/anatomy_map.json";
import { HeartScene, LABELLED_TARGETS, type AnatomyMap, type SceneOptions } from "../three/HeartScene";
import type { SceneState } from "../three/sceneState";

const META = { anatomy_map: anatomyMap } as unknown as Meta; // HeartScene reads only the anatomy map
const MAP = anatomyMap as unknown as AnatomyMap;
export type Artery = (typeof LABELLED_TARGETS)[number];
const EMERALD = "#047857"; // emerald-700, the landing page's accent
const LIMITS = { minDistance: 1.5, maxDistance: 4.2, minPolarAngle: Math.PI * 0.2, maxPolarAngle: Math.PI * 0.8 };
const GAP = 4; // px between labels, and from the card edge

export interface LandingSceneProps {
  selected: Artery | null;
  onSelect: (artery: Artery | null) => void;
  onNotice: (text: string | null) => void;
  touch: boolean; // explicit 3D exploring on a touch screen: the canvas takes one-finger drags and pinches
  resetKey: number;
  zoomRef: MutableRefObject<((direction: 1 | -1) => void) | null>;
  onReady: () => void;
  onError: () => void;
  onUserCamera: () => void;
}

export default function LandingHeartScene({ selected, onSelect, onNotice, touch, resetKey, zoomRef, onReady, onError,
  onUserCamera }: LandingSceneProps) {
  const host = useRef<HTMLDivElement>(null);
  const labels = useRef<Partial<Record<Artery, HTMLButtonElement | null>>>({});
  const points = useRef<Partial<Record<Artery, { x: number; y: number; visible: boolean }>>>({});
  const selectedRef = useRef(selected);
  useEffect(() => { selectedRef.current = selected; }, [selected]);
  // Unmounting the canvas forces a context loss on purpose (R3F frees the GPU); only a loss while shown is a failure.
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const onLost = useCallback(() => { if (live.current) onError(); }, [onError]);

  // A controlled scene: HeartScene's clicks come back here as selections (the myocardium means the whole heart).
  const sceneState = useMemo<SceneState>(() => ({
    kind: "anatomy", selected, viewPreset: null, hover: null, notice: null,
    select: (t: TargetId | null) => onSelect(t === "lad" || t === "lcx" || t === "rca" ? t : null),
    setViewPreset: () => undefined,
    // Hover only changes the cursor (no React state: a re-render per pointer move made dragging lag, D-033).
    setHover: (h) => {
      if (host.current) host.current.style.cursor = h && (h.node.startsWith("vessel_") || h.node === "heart_myocardium") ? "pointer" : "";
    },
    showNotice: (text) => {
      const node = Object.values(MAP.non_target_nodes).find((n) => n.message === text);
      onNotice(node ? `${node.label}: ${node.message.replace(/^[^:]*:\s*/, "")}` : text);
    },
  }), [selected, onSelect, onNotice]);

  // Labels follow their vessels each rendered frame, kept inside the card and never on top of one another: the
  // selected artery keeps its natural spot, the others move just clear of it.
  const layout = useCallback(() => {
    const box = host.current;
    if (!box) return;
    const W = box.clientWidth;
    const H = box.clientHeight;
    const order = [...LABELLED_TARGETS].sort((a, b) => Number(b === selectedRef.current) - Number(a === selectedRef.current));
    const placed: { l: number; t: number; r: number; b: number }[] = [];
    for (const t of order) {
      const el = labels.current[t];
      const p = points.current[t];
      if (!el || !p) continue;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const clampX = (x: number) => Math.min(Math.max(x, GAP), Math.max(GAP, W - w - GAP));
      const clampY = (y: number) => Math.min(Math.max(y, GAP), Math.max(GAP, H - h - GAP));
      const left = clampX(p.x - w / 2);
      let top = clampY(p.y - h - 10);
      for (let i = 0; i < placed.length + 1; i++) {
        const hit = placed.find((r) => left < r.r + GAP && left + w + GAP > r.l && top < r.b + GAP && top + h + GAP > r.t);
        if (!hit) break;
        const below = hit.b + GAP;
        top = below + h <= H - GAP ? below : clampY(hit.t - h - GAP);
      }
      if (p.visible) placed.push({ l: left, t: top, r: left + w, b: top + h });
      el.style.transform = `translate(${left}px, ${top}px)`;
      el.style.visibility = p.visible ? "visible" : "hidden";
    }
  }, []);
  const placeLabel = useCallback((t: TargetId, x: number, y: number, visible: boolean) => {
    if (t !== "lad" && t !== "lcx" && t !== "rca") return;
    points.current[t] = { x, y, visible };
    if (t === LABELLED_TARGETS[LABELLED_TARGETS.length - 1]) layout(); // all three known for this frame
  }, [layout]);

  const options = useMemo<SceneOptions>(() => ({
    isolation: true, showBody: false, accent: EMERALD, limits: LIMITS, wheelZoom: "modifier", touch, pan: false,
    resetKey, zoomRef, onReady, onError, onUserCamera,
    ariaLabel: "3D reference heart. Use the view buttons below the card to select an artery with the keyboard.",
  }), [touch, resetKey, zoomRef, onReady, onError, onUserCamera]);

  return (
    <div ref={host} className="absolute inset-0" data-testid="landing-heart-3d">
      <HeartScene meta={META} analysis={null} placeLabel={placeLabel} sceneState={sceneState} options={options}
                  onContextLost={onLost} />
      {/* Pointer shortcuts only: keyboard and screen-reader users select through the view buttons below the card. */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
        {LABELLED_TARGETS.map((t) => (
          <button key={t} type="button" tabIndex={-1} ref={(el) => { labels.current[t] = el; }} style={{ visibility: "hidden" }}
                  onClick={() => onSelect(t)} data-testid={`landing-heart-label-${t}`}
                  className={`pointer-events-auto absolute left-0 top-0 whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-bold tracking-wide shadow-sm ring-1 transition-colors ${
                    selected === t ? "bg-emerald-700 text-white ring-emerald-900"
                      : selected ? "bg-white/75 text-slate-500 ring-slate-300 hover:text-slate-900"
                        : "bg-white/95 text-slate-800 ring-slate-300 hover:ring-emerald-600"}`}>
            {selected === t && <span aria-hidden className="mr-1">●</span>}{MAP.targets[t].label}
          </button>
        ))}
      </div>
    </div>
  );
}
