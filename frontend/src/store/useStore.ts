// Transient UI state only (plan §11A "Frontend state authority"). Persistence (cases, analyses, reviews) belongs to
// the CaseStore/IndexedDB layer. Every 3D and panel interaction goes through `selectTarget` (plan §9.2).
import { create } from "zustand";
import type { DisplayAnalysis, TargetId } from "../api/client";

/** Off-screen renderer registered by the 3D scene: draws a camera preset to a PNG (never the live camera). */
export type SnapshotRenderer = (presetName: string) => { png_data_url: string; camera: Record<string, unknown> };

export type View = "overview" | "why" | "compare";
export type CaseMode = "dataset" | "new" | "cases";

/** The stored case whose current analysis is on screen (null = the analysis on screen is not saved). */
export interface CaseRef {
  caseId: string;
  displayId: string;
}

/** What "Save" needs for a new/imported case: the exact inputs behind the transient analysis on screen. */
export interface PendingCase {
  inputs: Record<string, number | string | null>;
  unitStatus: Record<string, string>;
  canonicalInputs: Record<string, unknown> | null;
  datasetRecordId: number | null;
  source: "manual" | "import";
}
/** Top-level screens. "workspace" is one open case, split into CaseTab tabs. */
export type Page = "home" | "library" | "cases" | "workspace" | "evidence" | "models";
export type CaseTab = "result" | "why" | "data" | "whatif";

export interface Hover {
  node: string;
  x: number;
  y: number;
}

interface State {
  page: Page;
  setPage: (page: Page) => void;
  caseTab: CaseTab;
  setCaseTab: (tab: CaseTab) => void;
  openStoredCase: () => void;
  mode: CaseMode;
  datasetPatientId: string | null;
  analysis: DisplayAnalysis | null;
  selectedTarget: TargetId | null;
  view: View;
  isolation: boolean;
  showBody: boolean; // translucent torso + rib cage context
  hover: Hover | null;
  notice: string | null; // e.g. "Left main: not a prediction target"
  viewPreset: string | null; // a camera view chosen without changing the target (cleared by the next selection)
  openDatasetPatient: (id: string | null) => void;
  startNewCase: () => void;
  openMyCases: () => void;
  caseRef: CaseRef | null;
  editingCaseId: string | null; // "Save" appends a new scenario to this case (edits never overwrite)
  pendingCase: PendingCase | null;
  setCaseRef: (ref: CaseRef | null) => void;
  setPendingCase: (pending: PendingCase | null) => void;
  setEditingCaseId: (caseId: string | null) => void;
  setAnalysis: (analysis: DisplayAnalysis | null) => void;
  selectTarget: (target: TargetId | null) => void;
  showCompare: () => void;
  setView: (view: View) => void;
  toggleIsolation: () => void;
  toggleBody: () => void;
  setHover: (hover: Hover | null) => void;
  showNotice: (notice: string | null) => void;
  snapshotRenderer: SnapshotRenderer | null;
  setSnapshotRenderer: (renderer: SnapshotRenderer | null) => void;
  setViewPreset: (preset: string | null) => void;
}

export const useStore = create<State>((set) => ({
  page: "home",
  setPage: (page) => set({ page }),
  caseTab: "result",
  setCaseTab: (caseTab) => set({ caseTab }),
  openStoredCase: () => set({ page: "workspace", caseTab: "result" }),
  mode: "dataset",
  datasetPatientId: null,
  analysis: null,
  selectedTarget: null,
  view: "overview",
  isolation: true,
  showBody: true,
  hover: null,
  notice: null,
  viewPreset: null,
  openDatasetPatient: (id) =>
    set((s) => (s.mode === "dataset" && s.datasetPatientId === id && id !== null
      // re-selecting the open patient only resets the view: the loaded analysis is still the right one
      ? { selectedTarget: null, view: "overview", notice: null, page: "workspace", caseTab: "result" }
      : { mode: "dataset", datasetPatientId: id, analysis: null, selectedTarget: null, view: "overview", notice: null,
          caseRef: null, pendingCase: null, editingCaseId: null, page: id ? "workspace" : "library", caseTab: "result" })),
  startNewCase: () =>
    set({ mode: "new", datasetPatientId: null, analysis: null, selectedTarget: null, view: "overview", notice: null,
          caseRef: null, pendingCase: null, editingCaseId: null, page: "workspace", caseTab: "data" }),
  openMyCases: () =>
    set({ mode: "cases", datasetPatientId: null, analysis: null, selectedTarget: null, view: "overview", notice: null,
          caseRef: null, pendingCase: null, editingCaseId: null, page: "cases" }),
  caseRef: null,
  editingCaseId: null,
  pendingCase: null,
  setCaseRef: (caseRef) => set({ caseRef }),
  setPendingCase: (pendingCase) => set({ pendingCase }),
  setEditingCaseId: (editingCaseId) => set({ editingCaseId }),
  // Fail closed: an analysis is replaced as a whole, never merged (no stale/new mix).
  setAnalysis: (analysis) => set({ analysis }),
  selectTarget: (target) =>
    set({ selectedTarget: target, notice: null, view: target ? "why" : "overview", viewPreset: null }),
  showCompare: () => set({ selectedTarget: null, view: "compare", viewPreset: null, notice: null }),
  setView: (view) => set({ view }),
  toggleIsolation: () => set((s) => ({ isolation: !s.isolation })),
  toggleBody: () => set((s) => ({ showBody: !s.showBody })),
  setHover: (hover) => set({ hover }),
  showNotice: (notice) => set({ notice }),
  snapshotRenderer: null,
  setSnapshotRenderer: (snapshotRenderer) => set({ snapshotRenderer }),
  setViewPreset: (viewPreset) => set({ viewPreset }),
}));
