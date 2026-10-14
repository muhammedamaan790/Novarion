// The landing hero's heart (D-031). The still image shows at once; on a wide screen with WebGL and without a
// reduced-motion preference, the moving 3D heart loads in the background and fades in over it, then visits the LAD,
// LCX and RCA in turn. Nothing on this page calls the API (it needs a session): the anatomy map is bundled with the
// scene (LandingHeartScene) and the model is a static file.
import { Suspense, lazy, useEffect, useState } from "react";
import type { TargetId } from "../api/client";
import { MODEL_URL } from "../three/modelUrl";
import { ANATOMY_NAME } from "./wording";

const Scene = lazy(() => import("./LandingHeartScene"));
const TOUR: readonly (TargetId | null)[] = [null, "lad", "lcx", "rca"];
const STEP_MS = 3500;

function motionWanted(): boolean {
  try {
    if (!window.matchMedia("(min-width: 1024px)").matches) return false; // the hero image column shows from lg up
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
    const canvas = document.createElement("canvas");
    return !!(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

export function LandingHeart() {
  const [loaded, setLoaded] = useState(false);
  const [shown, setShown] = useState(false);
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (!motionWanted()) return;
    let alive = true;
    // Fetch the model first, so the scene appears with the heart already in the browser cache.
    void fetch(MODEL_URL)
      .then((r) => { if (alive && r.ok) setLoaded(true); })
      .catch(() => undefined); // the still image stays
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    if (!loaded) return;
    const id = window.setTimeout(() => setShown(true), 600); // parse and first frame, then fade in
    return () => window.clearTimeout(id);
  }, [loaded]);
  useEffect(() => {
    if (!shown) return;
    const id = window.setInterval(() => { if (!document.hidden) setStep((s) => s + 1); }, STEP_MS);
    return () => window.clearInterval(id);
  }, [shown]);
  const target = TOUR[step % TOUR.length] ?? null;

  return (
    <figure className="w-full">
      <div className="relative w-full overflow-hidden rounded-2xl bg-[#f4f5f7] shadow-xl ring-1 ring-slate-900/5">
        <img src="/landing/heart.webp" width={870} height={773} className="h-auto w-full"
             alt="NOVARION's 3D reference heart with the LAD, LCX and RCA arteries labelled" />
        {loaded && (
          <div className={`absolute inset-0 transition-opacity duration-700 ${shown ? "opacity-100" : "opacity-0"}`}>
            <Suspense fallback={null}>
              <Scene target={target} />
            </Suspense>
          </div>
        )}
      </div>
      <figcaption className="mt-3 text-center text-xs text-slate-600">
        {shown && (
          <span className="mb-1 block text-sm font-bold text-emerald-700" data-testid="landing-heart-caption">
            {target ? ANATOMY_NAME[target] : "The whole heart: one prediction for each main artery"}
          </span>
        )}
        Reference anatomy from BodyParts3D (CC BY 4.0), not a patient.
      </figcaption>
    </figure>
  );
}
