// The landing hero's heart (D-031). The still image shows at once; on a wide screen with WebGL and without a
// reduced-motion preference, the moving 3D heart loads in the background and fades in over it, then visits the LAD,
// LCX and RCA in turn. The anatomy map comes from the public, release-pinned offline bundle (/demo_bundle/meta.json):
// the API needs a session, and nothing on this page may call it before sign-in.
import { Suspense, lazy, useEffect, useState } from "react";
import type { Meta, TargetId } from "../api/client";
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
  const [meta, setMeta] = useState<Meta | null>(null);
  const [shown, setShown] = useState(false);
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (!motionWanted()) return;
    let alive = true;
    // Fetch the model too, so the scene appears with the heart already in the browser cache.
    void Promise.all([fetch("/demo_bundle/meta.json").then((r) => (r.ok ? r.json() : null)), fetch(MODEL_URL)])
      .then(([doc]) => {
        if (alive && (doc as Meta | null)?.anatomy_map) setMeta(doc as Meta);
      })
      .catch(() => undefined); // the still image stays
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    if (!meta) return;
    const id = window.setTimeout(() => setShown(true), 600); // parse and first frame, then fade in
    return () => window.clearTimeout(id);
  }, [meta]);
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
        {meta && (
          <div className={`absolute inset-0 transition-opacity duration-700 ${shown ? "opacity-100" : "opacity-0"}`}>
            <Suspense fallback={null}>
              <Scene meta={meta} target={target} />
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
