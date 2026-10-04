// Transient UI state only (plan §11A "Frontend state authority"). Persistence (cases, analyses, reviews) belongs to
// the CaseStore/IndexedDB layer. Every 3D and panel interaction goes through `selectTarget` (plan §9.2).
import { create } from "zustand";
import type { DisplayAnalysis, TargetId } from "../api/client";

export type View = "overview" | "why";
export type CaseMode = "dataset" | "new";

export interface Hover {
  node: string;
  x: number;
  y: number;
}

interface State {
  mode: CaseMode;
  datasetPatientId: string | null;
  analysis: DisplayAnalysis | null;
  selectedTarget: TargetId | null;
  view: View;
  isolation: boolean;
  hover: Hover | null;
  notice: string | null; // e.g. "Left main: not a prediction target"
  viewPreset: string | null; // a camera view chosen without changing the target (cleared by the next selection)
  openDatasetPatient: (id: string | null) => void;
  startNewCase: () => void;
  setAnalysis: (analysis: DisplayAnalysis | null) => void;
  selectTarget: (target: TargetId | null) => void;
  setView: (view: View) => void;
  toggleIsolation: () => void;
  setHover: (hover: Hover | null) => void;
  showNotice: (notice: string | null) => void;
  setViewPreset: (preset: string | null) => void;
}

export const useStore = create<State>((set) => ({
  mode: "dataset",
  datasetPatientId: null,
  analysis: null,
  selectedTarget: null,
  view: "overview",
  isolation: true,
  hover: null,
  notice: null,
  viewPreset: null,
  openDatasetPatient: (id) =>
    set({ mode: "dataset", datasetPatientId: id, analysis: null, selectedTarget: null, view: "overview", notice: null }),
  startNewCase: () =>
    set({ mode: "new", datasetPatientId: null, analysis: null, selectedTarget: null, view: "overview", notice: null }),
  // Fail closed: an analysis is replaced as a whole, never merged (no stale/new mix).
  setAnalysis: (analysis) => set({ analysis }),
  selectTarget: (target) =>
    set({ selectedTarget: target, notice: null, view: target ? "why" : "overview", viewPreset: null }),
  setView: (view) => set({ view }),
  toggleIsolation: () => set((s) => ({ isolation: !s.isolation })),
  setHover: (hover) => set({ hover }),
  showNotice: (notice) => set({ notice }),
  setViewPreset: (viewPreset) => set({ viewPreset }),
}));
