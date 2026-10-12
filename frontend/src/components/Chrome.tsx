// Global chrome (plan §12): persistent, non-dismissible disclaimer + header with model status and mode chips.
import type { Meta, RunMode } from "../api/client";
import { useStore } from "../store/useStore";
import { DISCLAIMER } from "./wording";

export function DisclaimerBanner() {
  return (
    <div role="note" className="bg-amber-100 px-4 py-1.5 text-center text-xs font-medium text-amber-950" data-testid="disclaimer">
      ⚠ {DISCLAIMER} Predictions estimate dataset labels; they are not diagnoses and do not locate lesions.
    </div>
  );
}

function PageTabs() {
  const page = useStore((s) => s.page);
  const setPage = useStore((s) => s.setPage);
  return (
    <nav className="flex gap-1" aria-label="Screens">
      {([["command", "Command Center"], ["evidence", "Model Evidence"], ["models", "Model Center"]] as const).map(([id, label]) => (
        <button key={id} type="button" aria-current={page === id ? "page" : undefined} data-testid={`page-${id}`}
                onClick={() => setPage(id)}
                className={`rounded px-2 py-1 text-xs font-semibold ${page === id ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"}`}>
          {label}
        </button>
      ))}
    </nav>
  );
}

export function Header({ meta, ready, mock, runMode }: {
  meta: Meta | undefined; ready: boolean | undefined; mock: boolean; runMode: RunMode | undefined;
}) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-white px-4 py-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <div>
          <span className="text-base font-extrabold tracking-[0.2em] text-slate-900">NOVARION</span>
          <span className="ml-3 text-xs text-slate-500">coronary case review</span>
        </div>
        <PageTabs />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        {mock && (
          <span className="rounded bg-fuchsia-100 px-2 py-0.5 font-bold tracking-wide text-fuchsia-900" data-testid="mock-chip">
            MOCK DATA · NOT A MODEL
          </span>
        )}
        {runMode === "offline" ? (
          <span className="rounded bg-violet-100 px-2 py-0.5 font-bold tracking-wide text-violet-900" data-testid="run-mode"
                title="The backend is unreachable: precomputed dataset results from the verified static bundle are shown. No live inference.">
            DEMO MODE · STATIC BUNDLE
          </span>
        ) : (
          <span className="rounded bg-slate-100 px-2 py-0.5 text-slate-700" data-testid="run-mode">LIVE BACKEND</span>
        )}
        <span className="rounded bg-slate-100 px-2 py-0.5 text-slate-700">
          MODEL v{meta?.model_version ?? "?"}{" "}
          <span className={ready ? "text-emerald-700" : "text-red-700"}>●</span> {ready ? "READY" : "NOT READY"}
        </span>
        <span className="rounded bg-slate-100 px-2 py-0.5 text-slate-700">Data: Z-Alizadeh Sani (UCI #411)</span>
      </div>
    </header>
  );
}
