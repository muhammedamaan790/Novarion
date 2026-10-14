// The landing page's moving heart (D-031): the app's own 3D scene, with no patient and no controls. It shows the
// artery it is given (the camera flies to it and isolates it), or the whole heart. Loaded on demand, so the 3D engine
// is not part of the landing page's first download. Purely presentational: it takes no pointer input, so the page
// scrolls normally over it.
import { useCallback, useEffect, useRef } from "react";
import type { Meta, TargetId } from "../api/client";
// The committed anatomy map (the API serves this same file); bundled into this on-demand chunk, so the landing page
// needs neither the API (which requires a session) nor the offline export (absent on hosted builds).
import anatomyMap from "../../../config/anatomy_map.json";
import { HeartScene, LABELLED_TARGETS, type AnatomyMap } from "../three/HeartScene";
import { useAnatomyScene } from "../three/sceneState";

const META = { anatomy_map: anatomyMap } as unknown as Meta; // HeartScene reads only the anatomy map

export default function LandingHeartScene({ target }: { target: TargetId | null }) {
  const map = anatomyMap as unknown as AnatomyMap;
  const scene = useAnatomyScene();
  const labels = useRef<Partial<Record<TargetId, HTMLElement | null>>>({});
  const { select } = scene;
  useEffect(() => { select(target); }, [target]); // eslint-disable-line react-hooks/exhaustive-deps -- select is new each render

  const placeLabel = useCallback((t: TargetId, x: number, y: number, visible: boolean) => {
    const el = labels.current[t];
    if (!el) return;
    el.style.transform = `translate(-50%, -150%) translate(${x}px, ${y}px)`;
    el.style.visibility = visible ? "visible" : "hidden";
  }, []);

  return (
    <div className="pointer-events-none absolute inset-0 [&_*]:pointer-events-none!" data-testid="landing-heart-3d">
      <HeartScene meta={META} analysis={null} placeLabel={placeLabel} sceneState={scene} />
      <div className="absolute inset-0 overflow-hidden" aria-hidden>
        {LABELLED_TARGETS.map((t) => (
          <span key={t} ref={(el) => { labels.current[t] = el; }} style={{ visibility: "hidden" }}
                className={`absolute left-0 top-0 rounded px-1.5 py-0.5 text-[11px] font-semibold tracking-wide shadow-sm ${
                  target === t ? "bg-emerald-700 text-white" : target ? "bg-white/60 text-slate-500" : "bg-white/85 text-slate-800"
                }`}>
            {map.targets[t].label}
          </span>
        ))}
      </div>
    </div>
  );
}
