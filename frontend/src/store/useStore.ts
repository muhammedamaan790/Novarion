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
/** Top-level screens. "workspace" is the active open case, split into CaseTab tabs. */
export type Page = "home" | "library" | "cases" | "workspace" | "anatomy" | "evidence" | "models";
export type CaseTab = "result" | "why" | "data" | "whatif";

export interface Hover {
  node: string;
  x: number;
  y: number;
}

/** Everything that belongs to one open case. The active case lives in the flat fields below (so every panel reads
 *  it as before); the others are parked in their workspace entry until focused again (D-023). */
export interface CaseSlice {
  mode: CaseMode;
  datasetPatientId: string | null;
  analysis: DisplayAnalysis | null;
  selectedTarget: TargetId | null;
  view: View;
  caseTab: CaseTab;
  caseRef: CaseRef | null;
  pendingCase: PendingCase | null;
  editingCaseId: string | null;
}

/** One open patient workspace: a dataset patient, a new case, or a case reopened from My cases. */
export interface WorkspaceEntry {
  id: string;
  kind: "dataset" | "new" | "saved";
  key: string; // patient id, "new-N" or the stored case id: opening the same thing again focuses it
  label: string;
  snap: CaseSlice; // stale while this workspace is active (the flat fields are authoritative then)
}

const EMPTY_SLICE: CaseSlice = {
  mode: "dataset", datasetPatientId: null, analysis: null, selectedTarget: null, view: "overview", caseTab: "result",
  caseRef: null, pendingCase: null, editingCaseId: null,
};

interface State extends CaseSlice {
  page: Page;
  setPage: (page: Page) => void;
  setCaseTab: (tab: CaseTab) => void;
  workspaces: WorkspaceEntry[];
  activeId: string | null;
  newCaseCount: number;
  focusWorkspace: (id: string) => void;
  closeWorkspace: (id: string) => void;
  /** Writes into a workspace whether or not it is on screen: a background case keeps its own late results. */
  commitToWorkspace: (id: string, partial: Partial<CaseSlice>) => void;
  openSavedCase: (c: { caseId: string; displayId: string; analysis: DisplayAnalysis; editingCaseId: string | null }) => void;
  closeSavedCase: (caseId: string) => void;
  isolation: boolean;
  showBody: boolean; // translucent torso + rib cage context
  hover: Hover | null;
  notice: string | null; // e.g. "Left main: not a prediction target"
  viewPreset: string | null; // a camera view chosen without changing the target (cleared by the next selection)
  openDatasetPatient: (id: string | null) => void;
  startNewCase: () => void;
  openMyCases: () => void;
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

const sliceOf = (s: State): CaseSlice => ({
  mode: s.mode, datasetPatientId: s.datasetPatientId, analysis: s.analysis, selectedTarget: s.selectedTarget,
  view: s.view, caseTab: s.caseTab, caseRef: s.caseRef, pendingCase: s.pendingCase, editingCaseId: s.editingCaseId,
});

/** Park the active case in its entry, then load `id`'s case into the flat fields. */
function switchTo(s: State, workspaces: WorkspaceEntry[], id: string, page: Page = "workspace"): Partial<State> {
  const parked = workspaces.map((w) => (w.id === s.activeId ? { ...w, snap: sliceOf(s) } : w));
  const target = parked.find((w) => w.id === id)!;
  return { workspaces: parked, activeId: id, ...target.snap, notice: null, viewPreset: null, hover: null, page };
}

let seq = 0;
const newId = () => `ws-${Date.now().toString(36)}-${(seq += 1)}`;

export const useStore = create<State>((set) => ({
  ...EMPTY_SLICE,
  page: "home",
  setPage: (page) => set({ page }),
  setCaseTab: (caseTab) => set({ caseTab }),
  workspaces: [],
  activeId: null,
  newCaseCount: 0,
  focusWorkspace: (id) => set((s) => (s.workspaces.some((w) => w.id === id) ? switchTo(s, s.workspaces, id) : {})),
  closeWorkspace: (id) =>
    set((s) => {
      const index = s.workspaces.findIndex((w) => w.id === id);
      if (index < 0) return {};
      const rest = s.workspaces.filter((w) => w.id !== id);
      if (id !== s.activeId) return { workspaces: rest };
      const next = rest[index] ?? rest[index - 1];
      if (!next) return { workspaces: rest, activeId: null, ...EMPTY_SLICE, page: s.page === "workspace" ? "home" : s.page };
      return { workspaces: rest, activeId: next.id, ...next.snap, notice: null, viewPreset: null, hover: null };
    }),
  commitToWorkspace: (id, partial) =>
    set((s) => (s.activeId === id ? partial
      : { workspaces: s.workspaces.map((w) => (w.id === id ? { ...w, snap: { ...w.snap, ...partial } } : w)) })),
  openSavedCase: ({ caseId, displayId, analysis, editingCaseId }) =>
    set((s) => {
      // Reopening always shows the stored analysis as it is now (it may have been re-analysed since).
      const snap: CaseSlice = { ...EMPTY_SLICE, mode: "cases", analysis, caseRef: { caseId, displayId }, editingCaseId };
      const existing = s.workspaces.find((w) => w.kind === "saved" && w.key === caseId);
      if (existing) {
        const parked = s.workspaces.map((w) => (w.id === existing.id ? { ...w, snap } : w));
        return existing.id === s.activeId ? { workspaces: parked, ...snap, page: "workspace" } : switchTo(s, parked, existing.id);
      }
      const entry: WorkspaceEntry = { id: newId(), kind: "saved", key: caseId, label: displayId, snap };
      return switchTo(s, [...s.workspaces, entry], entry.id);
    }),
  closeSavedCase: (caseId) =>
    set((s) => {
      const open = s.workspaces.find((w) => w.kind === "saved" && w.key === caseId);
      // A deleted case can't stay on screen; any other workspace that saved into it simply becomes unsaved again.
      const cleared = s.workspaces.map((w) => (w.id !== s.activeId && w.snap.caseRef?.caseId === caseId
        ? { ...w, snap: { ...w.snap, caseRef: null } } : w));
      const active = s.caseRef?.caseId === caseId && s.activeId !== open?.id ? { caseRef: null } : {};
      if (!open) return { workspaces: cleared, ...active };
      const index = cleared.findIndex((w) => w.id === open.id);
      const rest = cleared.filter((w) => w.id !== open.id);
      if (open.id !== s.activeId) return { workspaces: rest, ...active };
      const next = rest[index] ?? rest[index - 1];
      return next ? { workspaces: rest, activeId: next.id, ...next.snap, notice: null, viewPreset: null }
        : { workspaces: rest, activeId: null, ...EMPTY_SLICE };
    }),
  isolation: true,
  showBody: true,
  hover: null,
  notice: null,
  viewPreset: null,
  openDatasetPatient: (id) =>
    set((s) => {
      if (id === null) return { page: "library" };
      const existing = s.workspaces.find((w) => w.kind === "dataset" && w.key === id);
      if (existing?.id === s.activeId) {
        // re-selecting the open patient only resets the view: the loaded analysis is still the right one
        return { selectedTarget: null, view: "overview", notice: null, page: "workspace", caseTab: "result" };
      }
      if (existing) return { ...switchTo(s, s.workspaces, existing.id), caseTab: "result" };
      const entry: WorkspaceEntry = {
        id: newId(), kind: "dataset", key: id, label: id, snap: { ...EMPTY_SLICE, mode: "dataset", datasetPatientId: id },
      };
      return switchTo(s, [...s.workspaces, entry], entry.id);
    }),
  startNewCase: () =>
    set((s) => {
      const n = s.newCaseCount + 1;
      const id = newId();
      const entry: WorkspaceEntry = {
        id, kind: "new", key: `new-${n}`, label: `New case ${n}`, snap: { ...EMPTY_SLICE, mode: "new", caseTab: "data" },
      };
      return { ...switchTo(s, [...s.workspaces, entry], id), newCaseCount: n };
    }),
  openMyCases: () => set({ page: "cases" }),
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

/** The analysis of one workspace, wherever it currently lives (flat fields if active, its entry otherwise). */
export const workspaceAnalysis = (s: State, id: string): DisplayAnalysis | null =>
  (s.activeId === id ? s.analysis : s.workspaces.find((w) => w.id === id)?.snap.analysis ?? null);
