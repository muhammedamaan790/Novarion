import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { TARGET_IDS, api, type TargetId } from "./api/client";
import { DisclaimerBanner, Header } from "./components/Chrome";
import { HeartView } from "./components/HeartView";
import { NewCasePanel } from "./components/NewCasePanel";
import { PatientPanel } from "./components/PatientPanel";
import { TargetCards } from "./components/TargetCards";
import { WhyPanel } from "./components/WhyPanel";
import { EvaluationPanel } from "./components/EvaluationPanel";
import { SHORT, pct, predictionText } from "./components/wording";
import { useStore } from "./store/useStore";

const KEY_TO_TARGET: Record<string, TargetId> = { "0": "cad", "1": "lad", "2": "lcx", "3": "rca" };

/** Deep links (plan §9.2): ?dataset=ZAS-0003&target=lad. Camera state is never in the URL; presets are derived. */
function useUrlSync(screen: "review" | "evaluation") {
  const datasetPatientId = useStore((s) => s.datasetPatientId);
  const selectedTarget = useStore((s) => s.selectedTarget);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const dataset = params.get("dataset");
    const target = params.get("target") as TargetId | null;
    if (dataset) useStore.getState().openDatasetPatient(dataset);
    if (target && TARGET_IDS.includes(target)) useStore.getState().selectTarget(target);
  }, []);
  useEffect(() => {
    const params = new URLSearchParams();
    if (screen === "evaluation") params.set("view", "evaluation");
    if (datasetPatientId) params.set("dataset", datasetPatientId);
    if (selectedTarget) params.set("target", selectedTarget);
    const query = params.toString();
    window.history.replaceState(null, "", query ? `?${query}` : window.location.pathname);
  }, [datasetPatientId, selectedTarget, screen]);
}

function useKeyboard(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey
        || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement
        || e.target instanceof HTMLSelectElement
        || (e.target instanceof HTMLElement && e.target.isContentEditable)) return;
      const target = KEY_TO_TARGET[e.key];
      if (target) useStore.getState().selectTarget(target);
      else if (e.key === "Escape") useStore.getState().selectTarget(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}

export default function App() {
  const [screen, setScreen] = useState<"review" | "evaluation">(() =>
    new URLSearchParams(window.location.search).get("view") === "evaluation" ? "evaluation" : "review",
  );
  const meta = useQuery({ queryKey: ["meta"], queryFn: api.meta, staleTime: Infinity });
  const ready = useQuery({ queryKey: ["ready"], queryFn: api.ready, retry: false });
  const mode = useStore((s) => s.mode);
  const datasetPatientId = useStore((s) => s.datasetPatientId);
  const analysis = useStore((s) => s.analysis);
  const selectedTarget = useStore((s) => s.selectedTarget);
  const setAnalysis = useStore((s) => s.setAnalysis);
  const patient = useQuery({
    queryKey: ["patient", datasetPatientId],
    queryFn: () => api.patient(datasetPatientId!),
    enabled: !!datasetPatientId,
    staleTime: Infinity,
  });
  useUrlSync(screen);
  useKeyboard(screen === "review");

  // Commit only a complete analysis (all four targets) for the currently opened patient; otherwise stay neutral.
  useEffect(() => {
    if (useStore.getState().mode !== "dataset") return; // new cases commit their own transient analyses
    const bundle = patient.data?.data;
    const complete = bundle && TARGET_IDS.every((t) => bundle.targets?.[t] && bundle.explanations?.[t]);
    setAnalysis(complete && bundle.patient_id === datasetPatientId ? bundle : null);
  }, [patient.data, datasetPatientId, setAnalysis]);

  const mock = !!(meta.data?.mock || patient.data?.mock);

  return (
    <div className="flex min-h-screen flex-col bg-slate-50 text-slate-900 lg:h-screen">
      <DisclaimerBanner />
      <Header meta={meta.data?.data} ready={ready.data?.data.ready} mock={mock} />
      <nav aria-label="Workspace views" className="flex gap-2 border-b border-slate-200 bg-white px-3 py-2">
        {(["review", "evaluation"] as const).map((view) => (
          <button key={view} type="button" data-testid={`nav-${view}`} aria-pressed={screen === view}
            onClick={() => setScreen(view)}
            className={`rounded-md px-3 py-2 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600 ${
              screen === view ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
            }`}>
            {view === "review" ? "Case review" : "Model evaluation"}
          </button>
        ))}
      </nav>
      {meta.isError && (
        <p role="alert" className="m-4 rounded bg-red-50 p-3 text-sm text-red-800">
          Backend unreachable or not ready: predictions disabled. Start the API (see README) and reload.
        </p>
      )}
      {patient.isError && screen === "review" && (
        <p role="alert" className="mx-4 mt-2 rounded bg-red-50 p-2 text-sm text-red-800">
          Analysis unavailable: no results shown.
        </p>
      )}
      {meta.data && (
        <main aria-label="Case review" className={screen === "review"
          ? "grid min-h-0 flex-1 grid-cols-1 gap-3 p-3 lg:grid-cols-[minmax(220px,22%)_1fr_minmax(300px,28%)]" : "hidden"}>
          <aside className="order-2 min-h-0 overflow-hidden rounded-lg border border-slate-200 bg-white p-3 lg:order-1">
            <div className="mb-2 flex gap-1" role="tablist" aria-label="Case source">
              {(["dataset", "new"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="tab"
                  aria-selected={mode === m}
                  data-testid={`tab-${m}`}
                  onClick={() => (m === "new" ? useStore.getState().startNewCase() : useStore.getState().openDatasetPatient(null))}
                  className={`flex-1 rounded px-2 py-1 text-xs font-semibold ${
                    mode === m ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                  }`}
                >
                  {m === "dataset" ? "Dataset library" : "New case"}
                </button>
              ))}
            </div>
            <div className="h-[34rem] lg:h-[calc(100%-2.25rem)]">
              {mode === "dataset" ? (
                <PatientPanel meta={meta.data.data} analysis={analysis} />
              ) : (
                <NewCasePanel meta={meta.data.data} />
              )}
            </div>
          </aside>
          <section className="order-1 min-h-[420px] lg:order-2" aria-label="3D coronary view">
            {screen === "review" && <HeartView meta={meta.data.data} analysis={analysis} />}
          </section>
          <aside className="order-3 min-h-0 space-y-4 overflow-auto rounded-lg border border-slate-200 bg-white p-3">
            {datasetPatientId || (mode === "new" && analysis) ? (
              <TargetCards analysis={analysis} meta={meta.data.data} />
            ) : (
              <p className="text-sm text-slate-500">
                {mode === "new" ? "Complete the form to see predictions." : "Open a dataset patient to see predictions."}
              </p>
            )}
            {analysis && selectedTarget && <WhyPanel analysis={analysis} target={selectedTarget} />}
          </aside>
        </main>
      )}
      {meta.data && screen === "evaluation" && <EvaluationPanel meta={meta.data.data} metaMock={meta.data.mock} />}
      {analysis && screen === "review" && (
        <p className="sr-only" aria-live="polite">
          {TARGET_IDS.map((t) => {
            const p = analysis.targets[t];
            return p ? `${SHORT[t]}: ${predictionText(t, p)}, ${pct(p.probability)}, ${p.model_confidence} model confidence. ` : "";
          })}
        </p>
      )}
    </div>
  );
}
