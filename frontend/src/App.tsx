import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { SIGNED_OUT_EVENT, TARGET_IDS, api, detectRunMode, switchToOffline, type AuthSession, type TargetId } from "./api/client";
import { DisclaimerFooter, Header } from "./components/Chrome";
import { EvidencePage } from "./components/evidence/EvidencePageLazy";
import { ModelCenterPage } from "./components/modelcenter/ModelCenterPage";
import { MyCasesPanel } from "./components/MyCasesPanel";
import { selectAccountStorage } from "./cases/backup";
import { AnatomyPage } from "./components/AnatomyPage";
import { DatasetLibrary } from "./components/PatientPanel";
import { LandingPage } from "./components/LandingPage";
import { SignInPage } from "./components/SignInPage";
import { HomePage } from "./components/HomePage";
import { Workspace } from "./components/Workspace";
import { WorkspaceBar } from "./components/WorkspaceBar";
import { CONFIDENCE_LABEL, SHORT, predictionText, probPct } from "./components/wording";
import { type CaseTab, type Page, useStore } from "./store/useStore";

const KEY_TO_TARGET: Record<string, TargetId> = { "0": "cad", "1": "lad", "2": "lcx", "3": "rca" };

const URL_PAGES: readonly Page[] = ["library", "cases", "anatomy", "evidence", "models"];
const CASE_TABS: readonly CaseTab[] = ["result", "why", "data", "whatif", "risk"];

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
      if (useStore.getState().page !== "workspace") return; // shortcuts drive the open case only (D-025)
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
  // Signed out, the public landing page comes first (D-028); its Sign in buttons open #sign-in, so Back returns to it.
  const [signInShown, setSignInShown] = useState(() => window.location.hash === "#sign-in");
  useEffect(() => {
    const onHash = () => setSignInShown(window.location.hash === "#sign-in");
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    const onSignedOut = () => {
      queryClient.setQueryData<AuthSession>(["session"], (s) => (s ? { ...s, user: null } : s));
      setSignInShown(true); // an expired session goes straight back to the sign-in form, not the landing page
    };
    window.addEventListener(SIGNED_OUT_EVENT, onSignedOut);
    return () => window.removeEventListener(SIGNED_OUT_EVENT, onSignedOut);
  }, [queryClient]);
  const s = session.data; // an unreachable backend falls through: Main shows the error and the offline switch
  const storageUser = s?.auth_required && !s.user ? undefined : s?.user ?? null; // undefined: not signed in yet
  // Each account reads and writes only its own local stores (audit R04). Nothing below renders until they are open.
  const [openStorage, setOpenStorage] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (session.isPending || storageUser === undefined) return;
    let alive = true;
    void selectAccountStorage(storageUser).then(() => { if (alive) setOpenStorage(storageUser); });
    return () => { alive = false; };
  }, [session.isPending, storageUser]);
  if (session.isPending) return <div className="min-h-screen bg-slate-50" aria-busy />;
  if (s?.auth_required && !s.user) {
    if (!signInShown) return <LandingPage onSignIn={() => { window.location.hash = "sign-in"; setSignInShown(true); }} />;
    return <SignInPage accountsConfigured={s.accounts_configured} onSignedIn={(next) => {
      if (window.location.hash) window.history.replaceState(null, "", window.location.pathname + window.location.search);
      queryClient.setQueryData(["session"], next);
      void queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "session" }); // drop 401s from before
    }} />;
  }
  const signOut = async () => {
    await api.logout().catch(() => undefined);
    window.location.replace(window.location.pathname); // a clean slate: nothing of the previous user stays in memory
  };
  if (openStorage !== storageUser) return <div className="min-h-screen bg-slate-50" aria-busy />;
  return <Main user={s?.user ?? null} onSignOut={() => void signOut()} />;
}

function Main({ user, onSignOut }: { user: string | null; onSignOut: () => void }) {
  const meta = useQuery({ queryKey: ["meta"], queryFn: api.meta, staleTime: Infinity });
  const runMode = useQuery({ queryKey: ["runMode"], queryFn: detectRunMode, staleTime: Infinity });
  const queryClient = useQueryClient();
  const offlineSwitch = async () => {
    // The session stays: a signed-in user keeps their own case store offline (audit R04).
    if (await switchToOffline()) await queryClient.resetQueries({ predicate: (q) => q.queryKey[0] !== "session" });
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
          {page === "anatomy" && <AnatomyPage meta={meta.data.data} />}
          {page === "evidence" && <EvidencePage />}
          {page === "models" && <ModelCenterPage />}
        </main>
      )}
      <DisclaimerFooter />
      {analysis && (
        <p className="sr-only" aria-live="polite" data-testid="live-announcer">
          {TARGET_IDS.map((t) => {
            const p = analysis.targets[t];
            return p ? `${SHORT[t]}: ${predictionText(t, p)}, ${probPct(p.probability)}, ${CONFIDENCE_LABEL[p.model_confidence].toLowerCase()}. ` : "";
          })}
        </p>
      )}
    </div>
  );
}
