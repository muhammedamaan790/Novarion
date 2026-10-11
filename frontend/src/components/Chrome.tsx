// Global chrome (plan §12): persistent, non-dismissible disclaimer + header with model status and mode chips.
import type { Meta } from "../api/client";
import { DISCLAIMER } from "./wording";

export function DisclaimerBanner() {
  return (
    <div role="note" className="bg-amber-100 px-4 py-1.5 text-center text-xs font-medium text-amber-950" data-testid="disclaimer">
      ⚠ {DISCLAIMER} Predictions estimate dataset labels; they are not diagnoses and do not locate lesions.
    </div>
  );
}

export function Header({ meta, ready, mock }: { meta: Meta | undefined; ready: boolean | undefined; mock: boolean }) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-white px-4 py-2">
      <div>
        <span className="text-base font-extrabold tracking-[0.2em] text-slate-900">NOVARION</span>
        <span className="ml-3 text-xs text-slate-500">coronary case review</span>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        {mock && (
          <span className="rounded bg-fuchsia-100 px-2 py-0.5 font-bold tracking-wide text-fuchsia-900" data-testid="mock-chip">
            MOCK DATA · NOT A MODEL
          </span>
        )}
        <span className="rounded bg-slate-100 px-2 py-0.5 text-slate-700">LIVE BACKEND</span>
        <span className="rounded bg-slate-100 px-2 py-0.5 text-slate-700">
          MODEL v{meta?.model_version ?? "?"}{" "}
          <span className={ready ? "text-emerald-700" : "text-red-700"}>●</span> {ready ? "READY" : "NOT READY"}
        </span>
        <span className="rounded bg-slate-100 px-2 py-0.5 text-slate-700">Data: Z-Alizadeh Sani (UCI #411)</span>
      </div>
    </header>
  );
}
