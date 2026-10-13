// Global chrome (plan §12): navigation header + a thin disclaimer footer on every screen (brief item 5).
import type { RunMode } from "../api/client";
import { type Page, useStore } from "../store/useStore";
import { DISCLAIMER } from "./wording";

export function DisclaimerFooter() {
  return (
    <footer role="note" className="border-t border-slate-200 bg-white px-4 py-1 text-center text-xs font-medium text-slate-700"
            data-testid="disclaimer">
      {DISCLAIMER} Predictions estimate dataset labels; they are not diagnoses.
    </footer>
  );
}

const NAV: readonly (readonly [string, string])[] = [
  ["home", "Home"], ["new", "New case"], ["library", "Dataset library"], ["cases", "My cases"],
  ["evidence", "Model evidence"], ["models", "Model center"],
];

function NavTabs() {
  const page = useStore((s) => s.page);
  const mode = useStore((s) => s.mode);
  // The open case belongs to the tab it came from, so that tab stays highlighted inside the workspace.
  const current = page === "workspace" ? (mode === "new" ? "new" : mode === "cases" ? "cases" : "library") : page;
  const go = (id: string) => {
    const st = useStore.getState();
    if (id === "new") st.startNewCase();
    else if (id === "cases") st.openMyCases();
    else st.setPage(id as Page);
  };
  return (
    <nav className="flex flex-wrap gap-1" aria-label="Screens">
      {NAV.map(([id, label]) => (
        <button key={id} type="button" aria-current={current === id ? "page" : undefined} data-testid={`page-${id}`}
                onClick={() => go(id)}
                className={`rounded-md px-3 py-1.5 text-sm font-semibold ${
                  current === id ? "bg-slate-900 text-white" : "text-slate-700 hover:bg-slate-100"}`}>
          {label}
        </button>
      ))}
    </nav>
  );
}

export function Header({ mock, runMode, user, onSignOut }: {
  mock: boolean; runMode: RunMode | undefined; user: string | null; onSignOut: () => void;
}) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-white px-4 py-2">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
        <span className="text-lg font-extrabold tracking-[0.2em] text-slate-900">NOVARION</span>
        <NavTabs />
      </div>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        {/* Shown only when the numbers are NOT from the live model: these change what the screen means. */}
        {mock && (
          <span className="rounded bg-fuchsia-100 px-2 py-0.5 text-xs font-bold tracking-wide text-fuchsia-900" data-testid="mock-chip">
            MOCK DATA · NOT A MODEL
          </span>
        )}
        {runMode === "offline" && (
          <span className="rounded bg-violet-100 px-2 py-0.5 text-xs font-bold tracking-wide text-violet-900" data-testid="run-mode"
                title="The backend is unreachable: precomputed dataset results from the verified static bundle are shown. No live inference.">
            OFFLINE DEMO
          </span>
        )}
        {user && (
          <>
            <span className="font-semibold text-slate-800" data-testid="signed-in-user">{user}</span>
            <button type="button" onClick={onSignOut} data-testid="sign-out"
                    className="rounded-md px-2 py-1 font-semibold text-slate-700 ring-1 ring-slate-300 hover:bg-slate-100">
              Sign out
            </button>
          </>
        )}
      </div>
    </header>
  );
}
