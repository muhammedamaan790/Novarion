// "3D heart" page (D-025): the reference anatomy on its own, with no patient and no prediction. Its selection is
// private (useAnatomyScene), so exploring here never changes an open case, and it never renders Review Snapshots.
import type { Meta, TargetId } from "../api/client";
import { useStore } from "../store/useStore";
import { useAnatomyScene } from "../three/sceneState";
import { HeartView } from "./HeartViewLazy";
import { ANATOMY_NAME } from "./wording";

// General anatomy, worded for a reference heart; the dataset labels are defined in the evidence and the report.
const ABOUT: Record<TargetId, { course: string; supplies: string; inNovarion: string }> = {
  lad: {
    course: "Runs down the front of the heart in the anterior interventricular groove toward the apex, giving off diagonal and septal branches.",
    supplies: "The front wall of the left ventricle, the front two-thirds of the interventricular septum and, usually, the apex.",
    inNovarion: "One prediction target: the dataset's ≥50% LAD stenosis label. The whole vessel, branches included, is tinted as one; where a narrowing lies within it is not known.",
  },
  lcx: {
    course: "Leaves the left main trunk and curves to the left and back in the left atrioventricular groove, giving off obtuse marginal branches.",
    supplies: "The lateral wall of the left ventricle and part of its back wall (more of it in a left-dominant circulation).",
    inNovarion: "One prediction target: the dataset's ≥50% LCX stenosis label, tinted as a whole vessel.",
  },
  rca: {
    course: "Leaves the aorta on the right and runs in the right atrioventricular groove around to the back of the heart.",
    supplies: "The right atrium and right ventricle and, in most people (a right-dominant circulation), the posterior descending artery and the inferior wall of the left ventricle.",
    inNovarion: "One prediction target: the dataset's ≥50% RCA stenosis label, tinted as a whole vessel.",
  },
  cad: {
    course: "The heart muscle (myocardium), fed by the three coronary arteries above.",
    supplies: "—",
    inNovarion: "Overall CAD is a whole-heart label in this dataset (a significant narrowing in at least one artery), so it has no single location; the heart body stands for it.",
  },
};

export function AnatomyPage({ meta }: { meta: Meta }) {
  const scene = useAnatomyScene();
  const selected = scene.selected;
  const about = selected ? ABOUT[selected] : null;
  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-3 p-3 lg:grid-cols-[1fr_minmax(320px,30%)]" data-testid="anatomy-page">
      <section className="min-h-[480px]" aria-label="3D heart, reference anatomy">
        <HeartView meta={meta} analysis={null} sceneState={scene} />
      </section>
      <aside className="min-h-0 space-y-4 overflow-auto rounded-lg border border-slate-200 bg-white p-4" data-testid="anatomy-info">
        <div>
          <h1 className="text-lg font-bold text-slate-900">3D heart</h1>
          <p className="mt-1 text-sm text-slate-700">
            The reference heart used in every case, shown without a patient. Rotate and zoom with the mouse, click an
            artery, or use the buttons and camera views.
          </p>
        </div>
        {about && selected ? (
          <div className="space-y-2" data-testid="anatomy-selected">
            <h2 className="text-base font-bold text-slate-900">{ANATOMY_NAME[selected]}</h2>
            <p className="text-sm text-slate-700"><span className="font-semibold">Course: </span>{about.course}</p>
            {about.supplies !== "—" && (
              <p className="text-sm text-slate-700"><span className="font-semibold">Supplies: </span>{about.supplies}</p>
            )}
            <p className="rounded-lg bg-slate-50 p-2 text-sm text-slate-700">
              <span className="font-semibold">In NOVARION: </span>{about.inNovarion}
            </p>
          </div>
        ) : (
          <p className="rounded-lg bg-slate-50 p-3 text-sm font-medium text-slate-700">
            Select the LAD, LCX or RCA to read about it. The short left main trunk, which splits into the LAD and LCX, is
            shown but is not a prediction target.
          </p>
        )}
        <div className="space-y-1 text-sm text-slate-700">
          <h2 className="text-sm font-bold uppercase tracking-wide text-slate-600">When a case is open</h2>
          <p>Each artery is tinted by its prediction: warm colours for stenosis predicted, cool for none. The deeper
            the colour, the further the probability is from the decision threshold.</p>
          <p>Predictions with high support in internal evaluation are full colour; those outside the qualified ranges are
            lighter with faint stripes.</p>
        </div>
        <button type="button" onClick={() => useStore.getState().setPage("library")} data-testid="anatomy-to-library"
                className="w-full rounded-lg bg-slate-900 py-2 text-sm font-bold text-white hover:bg-slate-700">
          See it with a patient's predictions →
        </button>
      </aside>
    </div>
  );
}
