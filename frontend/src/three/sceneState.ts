// Who drives a 3D heart (D-025). The case workspace's heart is driven by the app store, so 3D, cards, keyboard and URL
// stay one selection (plan §9.2). The "3D heart" page has its own private state: exploring the anatomy there never
// changes an open case, and only the case heart may render Review Snapshots.
import { useState } from "react";
import type { TargetId } from "../api/client";
import { type Hover, useStore } from "../store/useStore";

export interface SceneState {
  kind: "case" | "anatomy";
  selected: TargetId | null;
  viewPreset: string | null;
  hover: Hover | null;
  notice: string | null;
  select: (target: TargetId | null) => void;
  setViewPreset: (preset: string | null) => void;
  setHover: (hover: Hover | null) => void;
  showNotice: (notice: string | null) => void;
}

/** The open case's scene: a thin view of the store. */
export function useCaseScene(): SceneState {
  const selected = useStore((s) => s.selectedTarget);
  const viewPreset = useStore((s) => s.viewPreset);
  const hover = useStore((s) => s.hover);
  const notice = useStore((s) => s.notice);
  const st = useStore.getState();
  return {
    kind: "case", selected, viewPreset, hover, notice,
    select: st.selectTarget, setViewPreset: st.setViewPreset, setHover: st.setHover, showNotice: st.showNotice,
  };
}

/** A private scene for the anatomy page; same rules as the store (a selection clears the preset and the notice). */
export function useAnatomyScene(): SceneState {
  const [selected, setSelected] = useState<TargetId | null>(null);
  const [viewPreset, setViewPreset] = useState<string | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const [notice, showNotice] = useState<string | null>(null);
  return {
    kind: "anatomy", selected, viewPreset, hover, notice,
    select: (target) => { setSelected(target); setViewPreset(null); showNotice(null); },
    setViewPreset, setHover, showNotice,
  };
}
