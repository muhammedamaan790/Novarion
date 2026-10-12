import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { TARGET_IDS, api, detectRunMode, switchToOffline, type TargetId } from "./api/client";
import { DisclaimerBanner, Header } from "./components/Chrome";
import { EvidencePage } from "./components/evidence/EvidencePage";
import { ModelCenterPage } from "./components/modelcenter/ModelCenterPage";
import { CaseBar } from "./components/CaseBar";
import { CompareHeatmap } from "./components/CompareHeatmap";
import { MyCasesPanel } from "./components/MyCasesPanel";
import { HeartView } from "./components/HeartView";
import { NewCasePanel } from "./components/NewCasePanel";
import { PatientPanel } from "./components/PatientPanel";
import { TargetCards } from "./components/TargetCards";
import { WhyPanel } from "./components/WhyPanel";
import { SHORT, predictionText, probPct } from "./components/wording";
import { useStore } from "./store/useStore";

const KEY_TO_TARGET: Record<string, TargetId> = { "0": "cad", "1": "lad", "2": "lcx", "3": "rca" };

/** Deep links (plan §9.2): ?dataset=ZAS-0003&target=lad. Camera state is never in the URL; presets are derived. */
function useUrlSync() {
  const datasetPatientId = useStore((s) => s.datasetPatientId);
  const selectedTarget = useStore((s) => s.selectedTarget);
  const page = useStore((s) => s.page);
  const view = useStore((s) => s.view);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const deepPage = params.get("page");
    if (deepPage === "evidence" || deepPage === "models") useStore.getState().setPage(deepPage);
    const deepView = params.get("view");
    const dataset = params.get("dataset");
    const target = params.get("target") as TargetId | null;
    if (dataset) useStore.getState().openDatasetPatient(dataset);
    if (target && TARGET_IDS.includes(target)) useStore.getState().selectTarget(target);
    else if (deepView === "compare") useStore.getState().showCompare();
  }, []);
  useEffect(() => {
    const params = new URLSearchParams();
    if (page !== "command") params.set("page", page);
    if (datasetPatientId) params.set("dataset", datasetPatientId);
    if (selectedTarget) params.set("target", selectedTarget);
    if (view === "compare") params.set("view", "compare");
    const query = params.toString();
    window.history.replaceState(null, "", query ? `?${query}` : window.location.pathname);
  }, [datasetPatientId, selectedTarget, page, view]);
}

function useKeyboard() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const target = KEY_TO_TARGET[e.key];
      if (target) useStore.getState().selectTarget(target);
      else if (e.key === "Escape") useStore.getState().selectTarget(null);
      else if (e.key === "c" || e.key === "C") useStore.getState().showCompare();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export default function App() {
  const meta = useQuery({ queryKey: ["meta"], queryFn: api.meta, staleTime: Infinity });
  const runMode = useQuery({ queryKey: ["runMode"], queryFn: detectRunMode, staleTime: Infinity });
  const ready = useQuery({ queryKey: ["ready"], queryFn: api.ready, retry: false });
  const queryClient = useQueryClient();
  const offlineSwitch = async () => {
    if (await switchToOffline()) await queryClient.resetQueries();
    else window.alert("No offline demo bundle is available in this build (scripts/export_demo_bundle.py).");
  };
  const switchButton = runMode.data !== "offline" && (
    <button type="button" onClick={() => void offlineSwitch()} data-testid="switch-offline"
            className="ml-2 rounded bg-white px-2 py-0.5 text-xs font-semibold text-red-900 ring-1 ring-red-200">
      Switch to offline demo
    </button>
  );
  const mode = useStore((s) => s.mode);
  const page = useStore((s) => s.page);
  const view = useStore((s) => s.view);
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
  useUrlSync();
  useKeyboard();

  // Commit only a complete analysis (all four targets) for the currently opened patient; otherwise stay neutral.
  useEffect(() => {
    if (useStore.getState().mode !== "dataset") return; // new cases commit their own transient analyses
    const bundle = patient.data?.data;
    const complete = bundle && TARGET_IDS.every((t) => bundle.targets[t] && bundle.explanations[t]);
    setAnalysis(complete && bundle.patient_id === datasetPatientId ? bundle : null);
  }, [patient.data, datasetPatientId, setAnalysis]);

  const mock = !!(meta.data?.mock || patient.data?.mock);

  return (
    <div className="flex h-screen flex-col bg-slate-50 text-slate-900">
      <DisclaimerBanner />
      <Header meta={meta.data?.data} ready={ready.data?.data.ready} mock={mock} runMode={runMode.data} />
      {meta.isError && (
        <p role="alert" className="m-4 rounded bg-red-50 p-3 text-sm text-red-800">
          Backend unreachable or not ready: predictions disabled. Start the API (see README) and reload.
          {switchButton}
        </p>
      )}
      {patient.isError && (
        <p role="alert" className="mx-4 mt-2 rounded bg-red-50 p-2 text-sm text-red-800">
          Analysis unavailable: no results shown.
          {switchButton}
        </p>
      )}
      {meta.data && page === "evidence" && (
        <main className="min-h-0 flex-1 overflow-auto"><EvidencePage /></main>
      )}
      {meta.data && page === "models" && (
        <main className="min-h-0 flex-1 overflow-auto"><ModelCenterPage /></main>
      )}
      {meta.data && page === "command" && (
        <main className="grid min-h-0 flex-1 grid-cols-1 gap-3 p-3 lg:grid-cols-[minmax(220px,22%)_1fr_minmax(300px,28%)]">
          <aside className="order-2 min-h-0 overflow-hidden rounded-lg border border-slate-200 bg-white p-3 lg:order-1">
            <div className="mb-2 flex gap-1" role="tablist" aria-label="Case source">
              {(["dataset", "new", "cases"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="tab"
                  aria-selected={mode === m}
                  data-testid={`tab-${m}`}
                  onClick={() => (m === "new" ? useStore.getState().startNewCase()
                    : m === "cases" ? useStore.getState().openMyCases() : useStore.getState().openDatasetPatient(null))}
                  className={`flex-1 rounded px-2 py-1 text-xs font-semibold ${
                    mode === m ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                  }`}
                >
                  {m === "dataset" ? "Dataset library" : m === "new" ? "New case" : "My cases"}
                </button>
              ))}
            </div>
            <div className="h-[calc(100%-2.25rem)]">
              {mode === "dataset" ? (
                <PatientPanel meta={meta.data.data} analysis={analysis} />
              ) : mode === "new" && runMode.data === "offline" ? (
                <p className="rounded bg-violet-50 p-3 text-sm text-violet-900" data-testid="new-case-offline">
                  New cases need the live model, which is unreachable. In offline demo mode you can open any dataset
                  patient (precomputed out-of-fold results), save cases, review them and create Review Snapshots.
                </p>
              ) : mode === "new" ? (
                <NewCasePanel meta={meta.data.data} />
              ) : (
                <MyCasesPanel />
              )}
            </div>
          </aside>
          <section className="order-1 min-h-[420px] lg:order-2" aria-label="3D coronary view">
            <HeartView meta={meta.data.data} analysis={analysis} />
          </section>
          <aside className="order-3 min-h-0 space-y-4 overflow-auto rounded-lg border border-slate-200 bg-white p-3">
            {analysis && <CaseBar analysis={analysis} meta={meta.data.data} />}
            {analysis && !selectedTarget && view === "compare" && <CompareHeatmap analysis={analysis} />}
            {datasetPatientId || analysis ? (
              <TargetCards analysis={analysis} meta={meta.data.data} />
            ) : (
              <p className="text-sm text-slate-500">
                {mode === "new" ? "Complete the form to see predictions."
                  : mode === "cases" ? "Open a saved case to see its stored analysis." : "Open a dataset patient to see predictions."}
              </p>
            )}
            {analysis && selectedTarget && <WhyPanel analysis={analysis} target={selectedTarget} />}
          </aside>
        </main>
      )}
      {analysis && (
        <p className="sr-only" aria-live="polite">
          {TARGET_IDS.map((t) => {
            const p = analysis.targets[t];
            return p ? `${SHORT[t]}: ${predictionText(t, p)}, ${probPct(p.probability)}, ${p.model_confidence} model confidence. ` : "";
          })}
        </p>
      )}
    </div>
  );
}
