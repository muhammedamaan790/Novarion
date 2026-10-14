// One open case, split into tabs so each screen shows one thing: Result · Why · Patient data · What-if.
// Every tab stays mounted (hidden, not unmounted): the New case form keeps its values and live prediction, and the
// 3D scene keeps its camera, while another tab is shown.
import { TARGET_IDS, type DisplayAnalysis, type Meta, type RunMode, type TargetId } from "../api/client";
import { type CaseTab, useStore } from "../store/useStore";
import { CaseBar } from "./CaseBar";
import { CompareHeatmap } from "./CompareHeatmap";
import { HeartView } from "./HeartViewLazy";
import { NewCasePanel } from "./NewCasePanel";
import { PatientData } from "./PatientPanel";
import { Summary, TargetCards } from "./TargetCards";
import { WhatIfPanel } from "./WhatIfPanel";
import { WhyPanel } from "./WhyPanel";
import { MODE_BADGE, SHORT } from "./wording";

const TABS: readonly (readonly [CaseTab, string])[] = [
  ["result", "Result"], ["why", "Why"], ["data", "Patient data"], ["whatif", "What-if"],
];

function TargetPicker({ withCompare = false, testPrefix }: { withCompare?: boolean; testPrefix: string }) {
  const selected = useStore((s) => s.selectedTarget);
  const view = useStore((s) => s.view);
  const compare = withCompare && view === "compare";
  const shown = compare ? null : selected ?? "cad";
  const button = (active: boolean) => `rounded-md px-3 py-1.5 text-sm font-semibold ${
    active ? "bg-slate-900 text-white" : "bg-white text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50"}`;
  return (
    <div className="flex flex-wrap gap-1" role="group" aria-label="Choose target">
      {TARGET_IDS.map((t) => (
        <button key={t} type="button" aria-pressed={shown === t} data-testid={`${testPrefix}-${t}`}
                onClick={() => useStore.getState().selectTarget(t)} className={button(shown === t)}>
          {t === "cad" ? "Overall CAD" : SHORT[t]}
        </button>
      ))}
      {withCompare && (
        <button type="button" aria-pressed={compare} data-testid={`${testPrefix}-compare`}
                onClick={() => useStore.getState().showCompare()} className={button(compare)}>
          All targets
        </button>
      )}
    </div>
  );
}

function Title({ analysis }: { analysis: DisplayAnalysis | null }) {
  const mode = useStore((s) => s.mode);
  const datasetPatientId = useStore((s) => s.datasetPatientId);
  const caseRef = useStore((s) => s.caseRef);
  const label = useStore((s) => s.workspaces.find((w) => w.id === s.activeId)?.label ?? "New case");
  const inputs = (analysis as (DisplayAnalysis & { canonical_inputs?: Record<string, unknown> }) | null)?.canonical_inputs;
  const who = inputs && typeof inputs.age === "number" ? ` · ${inputs.age} y · ${inputs.sex === 1 ? "male" : "female"}` : "";
  const title = mode === "dataset" ? `${datasetPatientId ?? ""}${who}`
    : mode === "new" ? (caseRef ? `${caseRef.displayId}${who}` : label) : `${caseRef?.displayId ?? "Saved case"}${who}`;
  return (
    <div className="flex items-center gap-3">
      <h1 className="text-lg font-bold text-slate-900">{title}</h1>
      {analysis && (
        <span className="rounded bg-indigo-50 px-2 py-0.5 text-xs font-bold tracking-wide text-indigo-800">
          {MODE_BADGE[analysis.patient.prediction_mode]}
        </span>
      )}
    </div>
  );
}

export function Workspace({ meta, analysis, runMode }: { meta: Meta; analysis: DisplayAnalysis | null; runMode: RunMode | undefined }) {
  const mode = useStore((s) => s.mode);
  const tab = useStore((s) => s.caseTab);
  const selectedTarget = useStore((s) => s.selectedTarget);
  const view = useStore((s) => s.view);
  const target: TargetId = selectedTarget ?? "cad";
  const activeId = useStore((s) => s.activeId);
  const workspaces = useStore((s) => s.workspaces);
  const newCases = workspaces.filter((w) => w.kind === "new");
  const back = () => {
    const st = useStore.getState();
    if (mode === "cases") st.openMyCases();
    else if (mode === "dataset") st.openDatasetPatient(null);
    else st.setPage("home");
  };
  const pane = (id: CaseTab) => `min-h-0 flex-1 overflow-auto ${tab === id ? "" : "hidden"}`;
  const emptyNote = (
    <p className="text-sm font-medium text-slate-700">
      {mode === "new" ? "Fill in the patient data to see results." : "Loading the analysis…"}
    </p>
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <button type="button" onClick={back} data-testid="workspace-back"
                  className="rounded-md px-2 py-1 text-sm font-semibold text-slate-700 ring-1 ring-slate-300 hover:bg-slate-100">
            ← Back
          </button>
          <Title analysis={analysis} />
        </div>
        <div className="flex flex-wrap gap-1" role="tablist" aria-label="Case sections">
          {TABS.map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} data-testid={`case-tab-${id}`}
                    onClick={() => useStore.getState().setCaseTab(id)}
                    className={`rounded-md px-4 py-1.5 text-sm font-semibold ${
                      tab === id ? "bg-slate-900 text-white" : "bg-white text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50"}`}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <section className={pane("result")} aria-label="Result">
        <div className="grid h-full grid-cols-1 gap-3 lg:grid-cols-[1fr_minmax(340px,30%)]">
        <div className="min-h-[420px]" aria-label="3D coronary view">
          <HeartView meta={meta} analysis={analysis} />
        </div>
        <aside className="min-h-0 space-y-3 overflow-auto rounded-lg border border-slate-200 bg-white p-3">
          {/* One case bar per workspace: beside the form for a new case, here for dataset and saved cases. */}
          {analysis && mode !== "new" && <CaseBar analysis={analysis} meta={meta} />}
          {analysis || mode === "dataset" ? <TargetCards analysis={analysis} meta={meta} /> : emptyNote}
        </aside>
        </div>
      </section>

      <section className={`${pane("why")} rounded-lg border border-slate-200 bg-white p-4`} aria-label="Why">
        <div className="mx-auto max-w-4xl space-y-4">
          <TargetPicker withCompare testPrefix="why-pick" />
          {!analysis ? emptyNote : view === "compare" ? <CompareHeatmap analysis={analysis} />
            : <WhyPanel analysis={analysis} target={target} />}
        </div>
      </section>

      <section className={`${pane("data")} rounded-lg border border-slate-200 bg-white p-4`} aria-label="Patient data">
        {mode === "new" && runMode === "offline" && (
          <p className="rounded bg-violet-50 p-3 text-sm text-violet-900" data-testid="new-case-offline">
            New cases need the live model, which is unreachable. In offline demo mode you can open any dataset
            patient (precomputed out-of-fold results), save cases, review them and create Review Snapshots.
          </p>
        )}
        {/* Every open New case form stays mounted (only the active one is shown), so each keeps its values and its
            live prediction while you look at other workspaces (D-023). */}
        <div className={`grid h-full min-h-0 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,32%)] ${
          mode === "new" && runMode !== "offline" ? "" : "hidden"}`}>
          <div className="min-h-[34rem] lg:min-h-0">
            {newCases.map((w) => (
              <div key={w.id} className={`h-full ${w.id === activeId ? "" : "hidden"}`}>
                <NewCasePanel meta={meta} wsId={w.id} offerDraft={w.key === "new-1"} />
              </div>
            ))}
          </div>
          {/* The form and a live summary side by side: every edit re-predicts (brief: real-time updates). */}
          <aside className="space-y-3 overflow-auto">
            {mode === "new" && analysis && <CaseBar analysis={analysis} meta={meta} />}
            {analysis ? <Summary analysis={analysis} testId="live-summary" /> : emptyNote}
            {analysis && (
              <button type="button" onClick={() => useStore.getState().setCaseTab("result")} data-testid="see-result"
                      className="w-full rounded-lg bg-slate-900 py-2 text-sm font-bold text-white hover:bg-slate-700">
                See the result on the heart →
              </button>
            )}
          </aside>
        </div>
        {mode !== "new" && (analysis ? <PatientData meta={meta} analysis={analysis} /> : emptyNote)}
      </section>

      <section className={`${pane("whatif")} rounded-lg border border-slate-200 bg-white p-4`} aria-label="What-if">
        <div className="mx-auto max-w-4xl space-y-4">
          <TargetPicker testPrefix="whatif-pick" />
          {analysis ? <WhatIfPanel key={`${analysis.analysis_id}-${target}`} analysis={analysis} target={target} initiallyOpen />
            : emptyNote}
        </div>
      </section>
    </div>
  );
}

export function HomePage({ user }: { user: string | null }) {
  const st = useStore.getState();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-8 p-6">
      {user && <p className="text-lg font-semibold text-slate-700">Welcome, {user}</p>}
      <button type="button" onClick={() => st.startNewCase()} data-testid="home-new-case"
              className="rounded-2xl bg-slate-900 px-16 py-8 text-3xl font-extrabold tracking-[0.15em] text-white shadow-lg hover:bg-slate-700">
        NEW CASE
      </button>
      <div className="flex flex-wrap justify-center gap-3">
        <button type="button" onClick={() => st.setPage("library")} data-testid="home-library"
                className="rounded-lg bg-white px-6 py-3 text-base font-bold text-slate-800 ring-1 ring-slate-300 hover:bg-slate-50">
          Dataset library
        </button>
        <button type="button" onClick={() => st.openMyCases()} data-testid="home-cases"
                className="rounded-lg bg-white px-6 py-3 text-base font-bold text-slate-800 ring-1 ring-slate-300 hover:bg-slate-50">
          My cases
        </button>
        <button type="button" onClick={() => st.setPage("anatomy")} data-testid="home-anatomy"
                className="rounded-lg bg-white px-6 py-3 text-base font-bold text-slate-800 ring-1 ring-slate-300 hover:bg-slate-50">
          Explore the 3D heart
        </button>
      </div>
    </div>
  );
}
