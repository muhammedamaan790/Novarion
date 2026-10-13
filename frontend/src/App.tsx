import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { SIGNED_OUT_EVENT, TARGET_IDS, api, detectRunMode, switchToOffline, type AuthSession, type TargetId } from "./api/client";
import { DisclaimerFooter, Header } from "./components/Chrome";
import { EvidencePage } from "./components/evidence/EvidencePage";
import { ModelCenterPage } from "./components/modelcenter/ModelCenterPage";
import { MyCasesPanel } from "./components/MyCasesPanel";
import { DatasetLibrary } from "./components/PatientPanel";
import { SignInPage } from "./components/SignInPage";
import { HomePage, Workspace } from "./components/Workspace";
import { WorkspaceBar } from "./components/WorkspaceBar";
import { SHORT, predictionText, probPct } from "./components/wording";
import { type CaseTab, type Page, useStore } from "./store/useStore";

const KEY_TO_TARGET: Record<string, TargetId> = { "0": "cad", "1": "lad", "2": "lcx", "3": "rca" };

const URL_PAGES: readonly Page[] = ["library", "cases", "evidence", "models"];
const CASE_TABS: readonly CaseTab[] = ["result", "why", "data", "whatif"];

/** Deep links (plan §9.2): ?dataset=ZAS-0003&tab=why&target=lad, ?page=library. Camera state is never in the URL. */
function useUrlSync() {
  const datasetPatientId = useStore((s) => s.datasetPatientId);
  const selectedTarget = useStore((s) => s.selectedTarget);
  const page = useStore((s) => s.page);
  const view = useStore((s) => s.view);
  const caseTab = useStore((s) => s.caseTab);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const deepPage = params.get("page") as Page | null;
    if (deepPage && URL_PAGES.includes(deepPage)) useStore.getState().setPage(deepPage);
    const deepView = params.get("view");
    const dataset = params.get("dataset");
    const target = params.get("target") as TargetId | null;
    const tab = params.get("tab") as CaseTab | null;
    if (dataset) useStore.getState().openDatasetPatient(dataset);
    if (target && TARGET_IDS.includes(target)) useStore.getState().selectTarget(target);
    else if (deepView === "compare") useStore.getState().showCompare();
    if (dataset && tab && CASE_TABS.includes(tab)) useStore.getState().setCaseTab(tab);
  }, []);
  useEffect(() => {
    const params = new URLSearchParams();
    const inDataset = page === "workspace" && datasetPatientId;
    if (URL_PAGES.includes(page)) params.set("page", page);
    if (inDataset) params.set("dataset", datasetPatientId);
    if (inDataset && caseTab !== "result") params.set("tab", caseTab);
    if (inDataset && selectedTarget) params.set("target", selectedTarget);
    if (inDataset && view === "compare") params.set("view", "compare");
    const query = params.toString();
    window.history.replaceState(null, "", query ? `?${query}` : window.location.pathname);
  }, [datasetPatientId, selectedTarget, page, view, caseTab]);
}

function useKeyboard() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey
        || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement
        || e.target instanceof HTMLSelectElement
        || (e.target instanceof HTMLElement && e.target.isContentEditable)) return;
      const target = KEY_TO_TARGET[e.key];
      if (target) useStore.getState().selectTarget(target);
      else if (e.key === "Escape") useStore.getState().selectTarget(null);
      else if (e.key === "c" || e.key === "C") useStore.getState().showCompare();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** Sign-in gate (D-022): with accounts configured, nothing else renders (or calls the API) until signed in. */
export default function App() {
  const queryClient = useQueryClient();
  const session = useQuery({ queryKey: ["session"], queryFn: api.session, retry: false, staleTime: Infinity });
  useEffect(() => {
    const onSignedOut = () => queryClient.setQueryData<AuthSession>(["session"], (s) => (s ? { ...s, user: null } : s));
    window.addEventListener(SIGNED_OUT_EVENT, onSignedOut);
    return () => window.removeEventListener(SIGNED_OUT_EVENT, onSignedOut);
  }, [queryClient]);
  if (session.isPending) return <div className="min-h-screen bg-slate-50" aria-busy />;
  const s = session.data; // an unreachable backend falls through: Main shows the error and the offline switch
  if (s?.auth_required && !s.user) {
    return <SignInPage accountsConfigured={s.accounts_configured} onSignedIn={(next) => {
      queryClient.setQueryData(["session"], next);
      void queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "session" }); // drop 401s from before
    }} />;
  }
  const signOut = async () => {
    await api.logout().catch(() => undefined);
    window.location.replace(window.location.pathname); // a clean slate: nothing of the previous user stays in memory
  };
  return <Main user={s?.user ?? null} onSignOut={() => void signOut()} />;
}

function Main({ user, onSignOut }: { user: string | null; onSignOut: () => void }) {
  const meta = useQuery({ queryKey: ["meta"], queryFn: api.meta, staleTime: Infinity });
  const runMode = useQuery({ queryKey: ["runMode"], queryFn: detectRunMode, staleTime: Infinity });
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
  const page = useStore((s) => s.page);
  const hasWorkspace = useStore((s) => s.activeId !== null);
  const datasetPatientId = useStore((s) => s.datasetPatientId);
  const analysis = useStore((s) => s.analysis);
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
    const complete = bundle && TARGET_IDS.every((t) => bundle.targets?.[t] && bundle.explanations?.[t]);
    setAnalysis(complete && bundle.patient_id === datasetPatientId ? bundle : null);
  }, [patient.data, datasetPatientId, setAnalysis]);

  const mock = !!(meta.data?.mock || patient.data?.mock);

  return (
    <div className="flex min-h-screen flex-col bg-slate-50 text-slate-900 lg:h-screen">
      <Header mock={mock} runMode={runMode.data} user={user} onSignOut={onSignOut} />
      {meta.data && <WorkspaceBar />}
      {meta.isError && (
        <p role="alert" className="m-4 rounded bg-red-50 p-3 text-sm text-red-800">
          Backend unreachable or not ready: predictions disabled. Start the API (see README) and reload.
          {switchButton}
        </p>
      )}
      {patient.isError && page === "workspace" && (
        <p role="alert" className="mx-4 mt-2 rounded bg-red-50 p-2 text-sm text-red-800">
          Analysis unavailable: no results shown.
          {switchButton}
        </p>
      )}
      {meta.data && (
        <main className="min-h-0 flex-1 overflow-auto">
          {page === "home" && <HomePage user={user} />}
          {page === "library" && <DatasetLibrary />}
          {page === "cases" && <div className="mx-auto h-full w-full max-w-5xl p-6"><MyCasesPanel /></div>}
          {/* Mounted while any workspace is open, hidden on other pages: open New case forms keep their values.
              The 3D view renders on demand only, so a hidden workspace costs nothing. */}
          {hasWorkspace && (
            <div className={page === "workspace" ? "h-full" : "hidden"}>
              <Workspace meta={meta.data.data} analysis={analysis} runMode={runMode.data} />
            </div>
          )}
          {page === "evidence" && <EvidencePage />}
          {page === "models" && <ModelCenterPage />}
        </main>
      )}
      <DisclaimerFooter />
      {analysis && (
        <p className="sr-only" aria-live="polite" data-testid="live-announcer">
          {TARGET_IDS.map((t) => {
            const p = analysis.targets[t];
            return p ? `${SHORT[t]}: ${predictionText(t, p)}, ${probPct(p.probability)}, ${p.model_confidence} model confidence. ` : "";
          })}
        </p>
      )}
    </div>
  );
}
