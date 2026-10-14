// The landing hero's heart (D-031, D-036): "Explore the coronary arteries". The still image and every control show at
// once and work without 3D (the buttons update the artery information). On a wide screen with a fine pointer and
// WebGL, the explorable 3D heart loads lazily and replaces the image only once its first frame is drawn; on touch
// screens and narrow windows it loads only when the visitor asks ("Explore in 3D"), so page scrolling is never taken.
// A guided tour (one pass, Play/Pause) pauses on any manual interaction, off screen and in a hidden tab, and never
// starts on its own under reduced motion. Nothing here calls the API or touches the app store: the hero has no
// patient, makes no prediction, and cannot change a signed-in workspace.
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import type { Artery } from "./LandingHeartScene";

const Scene = lazy(() => import("./LandingHeartScene"));
type View = Artery | null;
const VIEWS: readonly { id: View; label: string }[] = [
  { id: null, label: "Whole heart" }, { id: "lad", label: "LAD" }, { id: "lcx", label: "LCX" }, { id: "rca", label: "RCA" },
];
const TOUR: readonly View[] = [null, "lad", "lcx", "rca", null];
const STEP_MS = 3500;

// Usual anatomy (individual anatomy and dominance vary). Wording checked against StatPearls (NCBI Bookshelf):
// "Anatomy, Thorax, Heart Left Anterior Descending (LAD) Artery" (NBK482375) and "Anatomy, Thorax, Heart Coronary
// Arteries" (NBK534790). Only the three labelled vessels are named; no branches the model does not have.
const INFO: Record<"whole" | Artery, { name: string; text: string }> = {
  whole: {
    name: "Whole heart · the coronary arteries",
    text: "The left main coronary artery divides into the LAD and the LCX, and the RCA arises separately from the aorta; together they supply the heart muscle.",
  },
  lad: {
    name: "LAD · Left anterior descending artery",
    text: "Runs down the front of the heart in the anterior interventricular groove toward the apex, and is the main supply of the front wall of the left ventricle and most of the septum.",
  },
  lcx: {
    name: "LCX · Left circumflex artery",
    text: "Curves around the left side of the heart in the left atrioventricular groove, and usually supplies the side and back walls of the left ventricle and the left atrium.",
  },
  rca: {
    name: "RCA · Right coronary artery",
    text: "Arises from the right side of the aorta and usually supplies the right atrium and right ventricle; in about 70% of people it also gives off the artery that supplies the back third of the septum.",
  },
};

type Status = "off" | "loading" | "ready" | "failed";

function media(query: string): boolean {
  try { return window.matchMedia(query).matches; } catch { return false; }
}
function webglAvailable(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return !!(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

const btn = "inline-flex items-center justify-center rounded-lg font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700";
const chip = "rounded-md bg-white/90 px-2 py-1 text-xs font-medium text-slate-700 shadow-sm ring-1 ring-slate-900/10";

export function LandingHeart({ onReviewCase }: { onReviewCase: () => void }) {
  // Decided once on mount (client only): what this device can and should do without being asked.
  const [env] = useState(() => {
    const webgl = webglAvailable();
    const desktop = media("(min-width: 1024px) and (pointer: fine)");
    return { webgl, auto3d: webgl && desktop, reducedMotion: media("(prefers-reduced-motion: reduce)") };
  });
  const [want3d, setWant3d] = useState(env.auto3d);
  const [touchExplore, setTouchExplore] = useState(false); // explicit activation: the canvas may take gestures
  const [loadState, setLoadState] = useState<Status>("off");
  const [selected, setSelected] = useState<View>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tour, setTour] = useState({ playing: false, step: 0 });
  const [resetKey, setResetKey] = useState(0);
  const [onscreen, setOnscreen] = useState(true);
  const [pageVisible, setPageVisible] = useState(() => typeof document === "undefined" || !document.hidden);
  const zoomRef = useRef<((direction: 1 | -1) => void) | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const autoTourDone = useRef(false);

  const status: Status = want3d && loadState === "off" ? "loading" : loadState;

  // Off screen or in a hidden tab, automatic work stops (the tour waits; the scene renders on demand only).
  useEffect(() => {
    const el = card.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setOnscreen(!!e?.isIntersecting), { threshold: 0.25 });
    io.observe(el);
    const onVis = () => setPageVisible(!document.hidden);
    document.addEventListener("visibilitychange", onVis);
    return () => { io.disconnect(); document.removeEventListener("visibilitychange", onVis); };
  }, []);

  const pauseTour = useCallback(() => setTour((t) => (t.playing ? { ...t, playing: false } : t)), []);
  const choose = useCallback((view: View) => { pauseTour(); setNotice(null); setSelected(view); }, [pauseTour]);
  // One automatic pass on a desktop once the 3D view is ready, never under reduced motion; afterwards only on Play.
  const onReady = useCallback(() => {
    setLoadState("ready");
    if (autoTourDone.current || !env.auto3d || env.reducedMotion) return;
    autoTourDone.current = true;
    setSelected(null);
    setTour({ playing: true, step: 0 });
  }, [env]);
  const onError = useCallback(() => setLoadState("failed"), []);
  const onNotice = useCallback((text: string | null) => setNotice(text), []);

  // The tour advances only while it plays, the 3D view is ready, the card is on screen and the tab is visible.
  useEffect(() => {
    if (!tour.playing || status !== "ready" || !onscreen || !pageVisible) return;
    const id = window.setTimeout(() => {
      const next = tour.step + 1;
      if (next >= TOUR.length) { setTour({ playing: false, step: 0 }); return; }
      setTour({ playing: true, step: next });
      setSelected(TOUR[next] ?? null);
    }, STEP_MS);
    return () => window.clearTimeout(id);
  }, [tour, status, onscreen, pageVisible]);
  const playTour = () => { setNotice(null); setSelected(TOUR[tour.step] ?? null); setTour({ playing: true, step: tour.step }); };

  const reset = () => { choose(null); setResetKey((k) => k + 1); };
  const startExplore = () => { setTouchExplore(true); setWant3d(true); };
  const stopExplore = () => { pauseTour(); setTouchExplore(false); setWant3d(env.auto3d); if (!env.auto3d) setLoadState("off"); };
  const ready = status === "ready";
  const info = INFO[selected ?? "whole"];
  const touchActive = touchExplore && !env.auto3d;

  return (
    <figure className="w-full max-w-xl" aria-labelledby="landing-heart-title" data-testid="landing-heart">
      <h2 id="landing-heart-title" className="mb-2 text-base font-bold text-slate-900">Explore the coronary arteries</h2>
      {/* Never taller than 75% of the screen (phones in landscape): the page around it stays reachable. */}
      <div ref={card} className="relative mx-auto aspect-[870/773] w-full max-w-[calc(75svh*870/773)] overflow-hidden rounded-2xl bg-[#f4f5f7] shadow-xl ring-1 ring-slate-900/5">
        <img src="/landing/heart.webp" width={870} height={773} className="h-full w-full object-cover"
             alt="NOVARION's 3D reference heart with the LAD, LCX and RCA arteries labelled" />
        {want3d && status !== "failed" && (
          <div className={`absolute inset-0 transition-opacity duration-500 ${ready ? "opacity-100" : "pointer-events-none opacity-0"}`}>
            <Suspense fallback={null}>
              <Scene selected={selected} onSelect={choose} onNotice={onNotice} touch={touchActive} resetKey={resetKey}
                     zoomRef={zoomRef} onReady={onReady} onError={onError} onUserCamera={pauseTour} />
            </Suspense>
          </div>
        )}

        {ready && (
          <div className="absolute right-3 top-3 flex gap-1.5">
            {(["out", "in"] as const).map((z) => (
              <button key={z} type="button" data-testid={`landing-heart-zoom-${z}`}
                      aria-label={z === "in" ? "Zoom in (or Ctrl + scroll)" : "Zoom out (or Ctrl + scroll)"}
                      title={z === "in" ? "Zoom in (Ctrl + scroll)" : "Zoom out (Ctrl + scroll)"}
                      onClick={() => { pauseTour(); zoomRef.current?.(z === "in" ? 1 : -1); }}
                      className={`${btn} size-11 bg-white/95 text-lg text-slate-800 shadow-sm ring-1 ring-slate-900/10 hover:bg-white lg:size-9`}>
                {z === "in" ? "+" : "−"}
              </button>
            ))}
            <button type="button" onClick={reset} data-testid="landing-heart-reset"
                    className={`${btn} h-11 bg-white/95 px-3 text-xs text-slate-800 shadow-sm ring-1 ring-slate-900/10 hover:bg-white lg:h-9`}>
              Reset view
            </button>
          </div>
        )}
        <div className="pointer-events-none absolute inset-x-3 bottom-3 flex items-end justify-between gap-2 [&>button]:pointer-events-auto">
          {status === "loading" ? <p role="status" className={chip}>Loading the 3D view…</p>
            : status === "failed" ? (
              <p role="status" className={chip} data-testid="landing-heart-failed">
                3D view unavailable here; the artery information below still works.
              </p>
            ) : (
              <p className={chip} data-testid="landing-heart-hint">
                {ready ? (touchActive ? "Drag to rotate · Pinch to zoom" : "Drag to rotate · Select an artery") : "Select an artery below"}
              </p>
            )}
          {!want3d && env.webgl && status !== "failed" && (
            <button type="button" onClick={startExplore} data-testid="landing-heart-explore"
                    className={`${btn} h-11 shrink-0 bg-emerald-700 px-4 text-sm text-white shadow-md hover:bg-emerald-800`}>
              Explore in 3D
            </button>
          )}
          {touchActive && (
            <button type="button" onClick={stopExplore} data-testid="landing-heart-done"
                    className={`${btn} h-11 shrink-0 bg-white/95 px-4 text-sm text-slate-800 shadow-sm ring-1 ring-slate-900/10`}>
              Done exploring
            </button>
          )}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <div role="group" aria-label="Choose a view" className="flex flex-wrap gap-1 rounded-xl bg-slate-100 p-1">
          {VIEWS.map((v) => {
            const on = selected === v.id;
            return (
              <button key={v.label} type="button" aria-pressed={on} onClick={() => choose(v.id)}
                      data-testid={`landing-heart-view-${v.id ?? "whole"}`}
                      className={`${btn} h-11 px-3.5 text-sm lg:h-9 ${on ? "bg-white text-emerald-800 shadow-sm ring-2 ring-emerald-700" : "text-slate-700 hover:bg-white/70"}`}>
                {on && <span aria-hidden className="mr-1 text-emerald-700">●</span>}{v.label}
              </button>
            );
          })}
        </div>
        {ready && (
          <button type="button" data-testid="landing-heart-tour" aria-pressed={tour.playing}
                  onClick={() => (tour.playing ? pauseTour() : playTour())}
                  className={`${btn} h-11 gap-1.5 px-3 text-sm text-slate-800 ring-1 ring-slate-300 hover:bg-slate-50 lg:h-9`}>
            <span aria-hidden>{tour.playing ? "❚❚" : "▶"}</span>
            {tour.playing ? "Pause tour" : "Guided tour"}
          </button>
        )}
      </div>

      <div className="mt-3 rounded-xl border border-slate-200 bg-white px-4 py-3 text-left" data-testid="landing-heart-info">
        <p aria-live="polite">
          <span className="block text-sm font-bold text-emerald-800" data-testid="landing-heart-caption">{info.name}</span>
          <span className="mt-0.5 block text-sm text-slate-700">{notice ?? info.text}</span>
        </p>
        <p className="mt-2 text-xs font-medium text-slate-600">
          Novarion estimates an artery-level disease label; it does not locate a lesion.
        </p>
      </div>

      <figcaption className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-xs text-slate-600">
        <span>
          <span className="block font-semibold text-slate-700" data-testid="landing-heart-badge">
            Reference anatomy · Educational demonstration · Not patient-specific
          </span>
          3D anatomy from BodyParts3D (CC BY 4.0), not a patient.
        </span>
        <button type="button" onClick={onReviewCase} data-testid="landing-heart-review"
                className={`${btn} h-11 border border-emerald-700 px-4 text-sm text-emerald-800 hover:bg-emerald-50 lg:h-9`}>
          Review a case →
        </button>
      </figcaption>
    </figure>
  );
}
