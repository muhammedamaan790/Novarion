// Open-patient workspaces (D-023): one tab per open case, a close button on each, and a search box that finds an open
// patient by ID, case number, sex, age or risk factor, or offers to open a dataset patient that isn't open yet.
import { useQuery } from "@tanstack/react-query";
import { useState, type KeyboardEvent } from "react";
import { api } from "../api/client";
import { type WorkspaceEntry, useStore } from "../store/useStore";

const KIND_TAG = { dataset: "Dataset", new: "New", saved: "Saved" } as const;

/** "12", "0012", "zas-12" or "ZAS-0012" → "ZAS-0012"; anything else → null. */
function patientIdFrom(query: string): string | null {
  const m = query.trim().match(/^(?:zas-?)?(\d{1,4})$/i);
  return m ? `ZAS-${m[1]!.padStart(4, "0")}` : null;
}

export function WorkspaceBar() {
  const workspaces = useStore((s) => s.workspaces);
  const activeId = useStore((s) => s.activeId);
  const activeCaseRef = useStore((s) => s.caseRef);
  const onWorkspace = useStore((s) => s.page === "workspace");
  const patients = useQuery({ queryKey: ["patients"], queryFn: api.patients, enabled: workspaces.length > 0 });
  const [query, setQuery] = useState("");
  if (workspaces.length === 0) return null;

  const byId = new Map((patients.data?.data.patients ?? []).map((p) => [p.patient_id, p]));
  const labelOf = (w: WorkspaceEntry) => {
    const ref = w.id === activeId ? activeCaseRef : w.snap.caseRef;
    return w.kind === "new" && ref ? ref.displayId : w.label; // a saved new case is named by its case number
  };
  const detailOf = (w: WorkspaceEntry) => {
    const p = w.kind === "dataset" ? byId.get(w.key) : undefined;
    return p ? `${p.age} y · ${p.sex}` : w.kind === "new" ? "unsaved" : "";
  };
  const haystack = (w: WorkspaceEntry) => {
    const p = w.kind === "dataset" ? byId.get(w.key) : undefined;
    const ref = w.id === activeId ? activeCaseRef : w.snap.caseRef;
    return [labelOf(w), w.label, ref?.displayId, KIND_TAG[w.kind], p?.sex, p?.age, ...(p?.key_risk_factors ?? [])]
      .filter(Boolean).join(" ").toLowerCase().replaceAll("_", " ");
  };
  const q = query.trim().toLowerCase();
  const shown = q ? workspaces.filter((w) => haystack(w).includes(q) || q.split(/\s+/).every((t) => haystack(w).includes(t))) : workspaces;
  const candidate = patientIdFrom(query);
  // A typed patient ID always wins: "6" also matches a 66-year-old, but it means ZAS-0006.
  const exact = candidate ? workspaces.find((w) => w.kind === "dataset" && w.key === candidate) : undefined;
  const canOpen = candidate && !exact && byId.has(candidate) ? candidate : null;
  const st = useStore.getState();
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      if (exact) st.focusWorkspace(exact.id);
      else if (canOpen) st.openDatasetPatient(canOpen);
      else if (shown[0]) st.focusWorkspace(shown[0].id);
      setQuery("");
    } else if (e.key === "Escape") setQuery("");
  };

  return (
    <div className="flex items-center gap-2 border-b border-slate-200 bg-slate-100 px-3 py-1.5" data-testid="workspace-bar">
      <span className="shrink-0 text-xs font-bold uppercase tracking-wide text-slate-600">Open ({workspaces.length})</span>
      <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey}
             placeholder="Search open patients…" aria-label="Search open patients" data-testid="workspace-search"
             className="w-44 shrink-0 rounded-md border border-slate-300 bg-white px-2 py-1 text-sm sm:w-56" />
      <nav className="flex min-w-0 flex-1 gap-1 overflow-x-auto" aria-label="Open patients">
        {shown.map((w) => {
          const active = onWorkspace && w.id === activeId;
          const label = labelOf(w);
          return (
            <div key={w.id} className={`flex shrink-0 items-center rounded-md ${
              active ? "bg-slate-900 text-white" : "bg-white text-slate-800 ring-1 ring-slate-300"}`}>
              <button type="button" aria-current={active ? "page" : undefined} data-testid={`ws-tab-${label}`}
                      onClick={() => { st.focusWorkspace(w.id); setQuery(""); }}
                      className="py-1 pl-2.5 pr-1 text-left text-sm font-semibold">
                {label}
                <span className={`ml-1.5 text-xs font-medium ${active ? "text-slate-300" : "text-slate-500"}`}>{detailOf(w)}</span>
              </button>
              <button type="button" aria-label={`Close ${label}`} data-testid={`ws-close-${label}`}
                      onClick={() => st.closeWorkspace(w.id)}
                      className={`rounded px-1.5 py-1 text-sm ${active ? "hover:bg-slate-700" : "text-slate-500 hover:bg-slate-100"}`}>
                ×
              </button>
            </div>
          );
        })}
        {canOpen && (
          <button type="button" data-testid="workspace-open-match" onClick={() => { st.openDatasetPatient(canOpen); setQuery(""); }}
                  className="shrink-0 rounded-md bg-white px-2.5 py-1 text-sm font-semibold text-slate-800 ring-1 ring-dashed ring-slate-400">
            Open {canOpen} from the library
          </button>
        )}
        {q && shown.length === 0 && !canOpen && (
          <span className="shrink-0 py-1 text-sm text-slate-600" data-testid="workspace-no-match">No open patient matches.</span>
        )}
      </nav>
    </div>
  );
}
