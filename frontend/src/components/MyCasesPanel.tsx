// Screen 5 "Case history" (plan §12A.7, .8): cases live only in this browser (IndexedDB); reopening renders the STORED
// analysis exactly as it was — no backend call, so it can never be re-explained by a newer model, and it works offline.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { caseStatus, currentAnalysis, exportCases, exportLearningPackage, importCases, listCases, toDisplay,
  type CaseImportReport } from "../cases/caseStore";
import type { CaseRecord } from "../cases/db";
import { download } from "../cases/snapshot";
import { useStore } from "../store/useStore";

const SOURCE_LABEL = { dataset: "Dataset (OOF)", manual: "Manual", import: "Imported" } as const;
const STATUS_STYLE = { "Unreviewed": "bg-amber-100 text-amber-900", "Reviewed": "bg-emerald-100 text-emerald-800",
  "Outcome recorded": "bg-sky-100 text-sky-900" } as const;
const STATUS_TEXT = { "Unreviewed": "Unreviewed", "Reviewed": "Review recorded", "Outcome recorded": "Outcome pending" } as const;

function open(c: CaseRecord) {
  const st = useStore.getState();
  st.setAnalysis(toDisplay(currentAnalysis(c)));
  st.setCaseRef({ caseId: c.case_id, displayId: c.display_id });
  st.setEditingCaseId(c.source === "dataset" ? null : c.case_id);
  st.selectTarget(null);
}

export function MyCasesPanel() {
  const cases = useQuery({ queryKey: ["cases"], queryFn: listCases });
  const caseRef = useStore((s) => s.caseRef);
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [importReport, setImportReport] = useState<CaseImportReport | null>(null);
  const withOutcomes = cases.data?.filter((c) => c.source !== "dataset" && c.outcomes?.length).length ?? 0;
  const onImport = async (file: File | undefined) => {
    if (!file) return;
    setImportReport(await importCases(await file.text()));
    await queryClient.invalidateQueries({ queryKey: ["cases"] });
    if (fileInput.current) fileInput.current.value = "";
  };
  return (
    <div className="flex h-full flex-col gap-2 overflow-hidden" data-testid="my-cases">
      <div className="flex items-center justify-between gap-2">
        <h2 className="mr-auto text-xs font-semibold uppercase tracking-wider text-slate-500">My cases</h2>
        <button type="button" className="text-[11px] text-slate-600 underline" disabled={!cases.data?.length}
                data-testid="cases-export"
                onClick={async () => download(`novarion-cases-${new Date().toISOString().slice(0, 10)}.json`,
                  new Blob([await exportCases()], { type: "application/json" }))}>
          Export all (JSON)
        </button>
        <button type="button" className="text-[11px] text-slate-600 underline" onClick={() => fileInput.current?.click()}
                data-testid="cases-import">
          Import (JSON)
        </button>
        <input ref={fileInput} type="file" accept=".json,application/json" className="hidden" data-testid="cases-import-file"
               onChange={(e) => void onImport(e.target.files?.[0])} />
      </div>
      {withOutcomes > 0 && (
        <div className="flex items-center justify-between gap-2 rounded border border-sky-200 bg-sky-50 p-2 text-[11px] text-sky-900">
          <span>
            {withOutcomes} case{withOutcomes === 1 ? "" : "s"} with a pending outcome. The learning package carries only
            allowlisted fields (inputs, outcome labels, source enums), for the model steward&apos;s offline verification.
          </span>
          <button type="button" data-testid="learning-package-export" className="shrink-0 rounded bg-sky-800 px-2 py-1 font-semibold text-white"
                  onClick={async () => {
                    const pkg = await exportLearningPackage();
                    download(`novarion-learning-package-${new Date().toISOString().slice(0, 10)}.json`,
                      new Blob([pkg.text], { type: "application/json" }));
                  }}>
            Export learning package
          </button>
        </div>
      )}
      {importReport && (
        <div className="rounded border border-slate-200 p-2 text-[11px] text-slate-700" data-testid="cases-import-report">
          {importReport.imported.length > 0 && <p>Imported: {importReport.imported.join(", ")}</p>}
          {importReport.skipped.length > 0 && <p>Skipped: {importReport.skipped.join("; ")}</p>}
          {importReport.rejected.length > 0 && <p className="text-red-700">Rejected: {importReport.rejected.join("; ")}</p>}
        </div>
      )}
      <p className="rounded bg-slate-50 p-2 text-[11px] text-slate-600">
        Stored only in this browser (IndexedDB); the server keeps nothing. Browser storage is not an encrypted clinical
        database: hosted demo = de-identified or synthetic data only; for sensitive data run NOVARION locally with Docker.
      </p>
      {cases.data?.length === 0 && (
        <p className="text-sm text-slate-500">No cases yet. Open a dataset patient or create a new case, then “Save case”.</p>
      )}
      <ul className="min-h-0 flex-1 space-y-1 overflow-auto pr-1">
        {cases.data?.map((c) => {
          const status = caseStatus(c);
          return (
            <li key={c.case_id}>
              <button type="button" onClick={() => open(c)} data-testid={`case-${c.display_id}`}
                      className={`w-full rounded border px-2 py-1 text-left text-xs ${
                        caseRef?.caseId === c.case_id ? "border-slate-900 bg-slate-50" : "border-slate-200 bg-white hover:bg-slate-50"}`}>
                <span className="font-semibold">{c.display_id}</span> · {SOURCE_LABEL[c.source]}
                {c.dataset_patient_id ? ` · ${c.dataset_patient_id}` : ""}
                <span className={`ml-1 rounded px-1 text-[10px] font-semibold ${STATUS_STYLE[status]}`}>
                  {STATUS_TEXT[status]}
                </span>
                <span className="block text-[10px] text-slate-500">
                  {c.created_at.replace("T", " ").replace("Z", " UTC")} · {c.scenarios.length} scenario
                  {c.scenarios.length === 1 ? "" : "s"} · {c.snapshots.length} snapshot{c.snapshots.length === 1 ? "" : "s"} ·
                  model v{currentAnalysis(c).model_version}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
