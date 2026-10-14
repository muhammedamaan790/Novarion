// Home / landing page after sign-in. Layout adapted from HyperUI (MIT, © Mark Mead): "Banner · Center" for the hero
// and "Feature grid · Grid with content" for How it works; icons from Heroicons (MIT, © Tailwind Labs), inline SVG so
// nothing loads from another origin. Every number is read from the served model's own evidence, never written here.
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { useStore } from "../store/useStore";
import { useBoundEvidence } from "./evidence/boundEvidence";

const ICONS = {
  patient: "M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z",
  heart: "M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12Z",
  why: "M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 0 1 3 19.875v-6.75ZM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V8.625ZM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V4.125Z",
} as const;

const STEPS: { icon: keyof typeof ICONS; title: string; text: string }[] = [
  { icon: "patient", title: "Enter or pick a patient",
    text: "Type the 55 clinical measurements, import a CSV or JSON file, or open one of the 303 dataset patients." },
  { icon: "heart", title: "See it on the heart",
    text: "Four predictions, overall CAD and each artery, coloured on a 3D heart, beside how well each model did in internal evaluation." },
  { icon: "why", title: "See why",
    text: "Which measurements pushed each prediction up or down, how stable it is, and how it responds when one input changes." },
];

function Icon({ d }: { d: string }) {
  return (
    <svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5}
         stroke="currentColor" className="size-6">
      <path strokeLinecap="round" strokeLinejoin="round" d={d} />
    </svg>
  );
}

const pct = (v: number) => `${(v * 100).toFixed(1).replace(/\.0$/, "")}%`;

export function HomePage({ user }: { user: string | null }) {
  const st = useStore.getState();
  const evaluation = useQuery({ queryKey: ["evaluation"], queryFn: api.evaluation, staleTime: Infinity });
  const shown = useBoundEvidence<{ targets: Record<string, { pct_high_positive: number; ppv: number | null }> }>("displayed_tiers");
  const cadRow = evaluation.data?.data.table1.find((r) => r.target === "cad" && r.model === "nested_cv_selected");
  const cadAuc = cadRow?.metrics.roc_auc?.mean;
  const prevalence = cadRow?.prevalence;
  const support = shown.current ? shown.data?.targets.cad : undefined; // only evidence for the model being served

  const facts = [
    { value: "303", label: "patients", detail: `one public, angiography-referred cohort (UCI #411)${prevalence ? `; ${pct(prevalence)} have CAD` : ""}` },
    cadAuc != null ? { value: cadAuc.toFixed(2), label: "CAD ROC-AUC", detail: "nested cross-validation, internal evaluation only" } : null,
    support?.ppv != null ? { value: pct(support.pct_high_positive), label: "of CAD calls with high support",
      detail: `right ${pct(support.ppv)} of the time in internal evaluation; no artery range qualified` } : null,
  ].filter((f): f is { value: string; label: string; detail: string } => f !== null);

  const secondary = "inline-block rounded border border-slate-300 bg-white px-5 py-3 font-semibold text-slate-800 shadow-sm transition-colors hover:bg-slate-50";
  return (
    <div className="h-full overflow-auto" data-testid="home-page">
      <section className="bg-white">
        <div className="mx-auto max-w-7xl px-4 py-14 sm:px-6 sm:py-20 lg:px-8">
          <div className="mx-auto max-w-prose text-center">
            {user && <p className="mb-3 text-sm font-semibold text-slate-600">Welcome, {user}</p>}
            <h1 className="text-4xl font-bold text-slate-900 sm:text-5xl">
              Coronary predictions <strong className="text-emerald-700">on the heart</strong>, and why
            </h1>
            <p className="mt-4 text-base text-pretty text-slate-700 sm:text-lg/relaxed">
              NOVARION estimates the angiography labels for overall CAD and for LAD, LCX and RCA stenosis from routine
              clinical measurements, shows them on a 3D heart, and explains what drove each one. An educational research
              prototype.
            </p>
            <div className="mt-6 flex flex-col items-center gap-4">
              <button type="button" onClick={() => st.startNewCase()} data-testid="home-new-case"
                      className="rounded-xl border border-slate-900 bg-slate-900 px-14 py-5 text-2xl font-extrabold tracking-[0.15em] text-white shadow-lg transition-colors hover:bg-slate-700">
                NEW CASE
              </button>
              <div className="flex flex-wrap justify-center gap-3">
                <button type="button" onClick={() => st.setPage("library")} data-testid="home-library" className={secondary}>
                  Dataset library
                </button>
                <button type="button" onClick={() => st.openMyCases()} data-testid="home-cases" className={secondary}>
                  My cases
                </button>
                <button type="button" onClick={() => st.setPage("anatomy")} data-testid="home-anatomy" className={secondary}>
                  Explore the 3D heart
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8" aria-label="How it works">
        <h2 className="text-center text-2xl font-bold text-slate-900 sm:text-3xl">How it works</h2>
        <div className="mt-8 grid grid-cols-1 gap-6 md:grid-cols-3">
          {STEPS.map((s, i) => (
            <div key={s.title} className="rounded-lg border border-slate-200 bg-white p-6">
              <div className="inline-flex rounded-lg bg-slate-100 p-3 text-slate-800"><Icon d={ICONS[s.icon]} /></div>
              <h3 className="mt-4 text-lg font-semibold text-slate-900">{i + 1}. {s.title}</h3>
              <p className="mt-2 text-pretty text-slate-700">{s.text}</p>
            </div>
          ))}
        </div>

        <div className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-3" data-testid="home-facts">
          {facts.map((f) => (
            <div key={f.label} className="rounded-lg bg-white p-5 text-center ring-1 ring-slate-200">
              <p className="text-3xl font-bold tabular-nums text-slate-900">{f.value}</p>
              <p className="text-sm font-semibold text-slate-700">{f.label}</p>
              <p className="mt-1 text-xs text-slate-600">{f.detail}</p>
            </div>
          ))}
        </div>
        <p className="mx-auto mt-6 max-w-3xl text-center text-sm text-slate-700">
          Evaluated internally on one cohort of 303 patients; not externally or clinically validated. It estimates
          dataset labels and does not diagnose or locate lesions.
        </p>
      </section>
    </div>
  );
}
