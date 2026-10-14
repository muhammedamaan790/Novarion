// Screen 5 "Case history" (plan §12A.7, .8): cases live only in this browser (IndexedDB); reopening renders the STORED
// analysis exactly as it was — no backend call, so it can never be re-explained by a newer model, and it works offline.
import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { listBackups, storageErrorMessage, storageHealth } from "../cases/backup";
import { caseStatus, currentAnalysis, deleteCase, exportCases, exportLearningPackage, importCases, listCasesChecked,
  legacyCases, moveLegacyCases, toDisplay, type CaseImportReport, type LegacyMoveReport } from "../cases/caseStore";
import { LEGACY_DB, db, type CaseRecord } from "../cases/db";
import { download } from "../cases/download";
import { useStore } from "../store/useStore";

const SOURCE_LABEL = { dataset: "Dataset (OOF)", manual: "Manual", import: "Imported" } as const;
const STATUS_STYLE = { "Unreviewed": "bg-amber-100 text-amber-900", "Reviewed": "bg-emerald-100 text-emerald-800",
  "Outcome recorded": "bg-sky-100 text-sky-900" } as const;
const STATUS_TEXT = { "Unreviewed": "Unreviewed", "Reviewed": "Review recorded", "Outcome recorded": "Outcome pending" } as const;

function open(c: CaseRecord, queryClient: QueryClient) {
  // Each stored case opens in its own workspace (or focuses it if it is already open). Storage is the source of truth:
  // drop any cached copy, which a workspace that stayed open in the background may still hold.
  void queryClient.invalidateQueries({ queryKey: ["case", c.case_id] });
  useStore.getState().openSavedCase({ caseId: c.case_id, displayId: c.display_id, analysis: toDisplay(currentAnalysis(c)),
                                      editingCaseId: c.source === "dataset" ? null : c.case_id });
}

export function MyCasesPanel() {
  const checked = useQuery({ queryKey: ["cases", "checked"], queryFn: listCasesChecked, retry: false });
  const cases = { data: checked.data?.cases };
  const health = useQuery({ queryKey: ["storage-health"], queryFn: storageHealth, enabled: checked.isError });
  const backups = useQuery({ queryKey: ["cases", "backups"], queryFn: listBackups, retry: false });
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const caseRef = useStore((s) => s.caseRef);
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [importReport, setImportReport] = useState<CaseImportReport | null>(null);
  const withOutcomes = cases.data?.filter((c) => c.source !== "dataset" && c.outcomes?.length).length ?? 0;
  const accountStore = db.name !== LEGACY_DB;
  // Cases saved in this browser before accounts existed: offered once to the signed-in account, moved only on click.
  const legacy = useQuery({ queryKey: ["cases", "legacy", db.name], queryFn: legacyCases, enabled: accountStore, retry: false });
  const [moveReport, setMoveReport] = useState<LegacyMoveReport | null>(null);
  const onImport = async (file: File | undefined) => {
    if (!file) return;
    setImportReport(await importCases(await file.text()));
    await queryClient.invalidateQueries({ queryKey: ["cases"] });
    if (fileInput.current) fileInput.current.value = "";
  };
  return (
    <div className="flex h-full flex-col gap-2 overflow-hidden" data-testid="my-cases">
      <p className="text-xs text-slate-600" data-testid="storage-scope"
         title="Cases live in this browser's local storage. Each signed-in account has its own store; this separates accounts, it does not encrypt them: anyone with access to this computer's browser profile can read them. Use de-identified data only.">
        {accountStore ? "Stored in this browser for your account only · not encrypted ⓘ"
          : "Stored in this browser, shared by everyone who uses it without signing in ⓘ"}
      </p>
      {legacy.data && legacy.data.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900"
             data-testid="legacy-cases">
          <span>
            {legacy.data.length} case{legacy.data.length === 1 ? " was" : "s were"} saved in this browser before accounts
            existed. They stay where they are unless you move them to your account.
          </span>
          <button type="button" data-testid="legacy-move" className="shrink-0 rounded bg-amber-700 px-2 py-1 font-semibold text-white"
                  onClick={async () => {
                    setMoveReport(await moveLegacyCases());
                    await queryClient.invalidateQueries({ queryKey: ["cases"] });
                  }}>
            Move to my account
          </button>
        </div>
      )}
      {moveReport && (
        <p className="text-xs text-slate-700" data-testid="legacy-report">
          {moveReport.moved.length > 0 && `Moved: ${moveReport.moved.join(", ")}. `}
          {moveReport.kept.length > 0 && `Kept in the shared store (number already used in your account): ${moveReport.kept.join(", ")}.`}
        </p>
      )}
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
      {checked.isError && (
        <div role="alert" className="rounded border border-red-300 bg-red-50 p-2 text-[11px] text-red-900" data-testid="storage-error">
          <p className="font-semibold">Local case storage could not be opened.</p>
          <p>{health.data?.error ?? (checked.error as Error | null)?.message}</p>
          <p>Nothing was changed or deleted. Restore from an automatic backup below or from a JSON export (Import).</p>
        </div>
      )}
      {(checked.data?.unreadable ?? 0) > 0 && (
        <p role="alert" className="rounded bg-amber-50 p-2 text-[11px] text-amber-900" data-testid="storage-unreadable">
          {checked.data!.unreadable} stored case record{checked.data!.unreadable === 1 ? " is" : "s are"} damaged and
          hidden. They are kept untouched; restore them from a backup or an export.
        </p>
      )}
      {deleteError && <p role="alert" className="text-[11px] text-red-700">Delete failed: {deleteError}</p>}
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
      {(backups.data?.length ?? 0) > 0 && (
        <details className="rounded border border-slate-200 p-2 text-[11px] text-slate-700" data-testid="backups">
          <summary className="cursor-pointer font-semibold">Automatic local backups (last {backups.data!.length})</summary>
          <ul className="mt-1 space-y-0.5">
            {backups.data!.map((b) => (
              <li key={b.id} className="flex items-center justify-between gap-2">
                <span>{b.created_at.replace("T", " ").replace("Z", " UTC")} · {b.case_count} case{b.case_count === 1 ? "" : "s"} · {b.reason}</span>
                <button type="button" className="underline" data-testid={`backup-download-${b.id}`}
                        onClick={() => download(`novarion-backup-${b.created_at.slice(0, 19).replaceAll(":", "")}.json`,
                          new Blob([b.json], { type: "application/json" }))}>
                  Download
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-slate-500">A downloaded backup restores through Import (JSON).</p>
        </details>
      )}
      <ul className="min-h-0 flex-1 space-y-1 overflow-auto pr-1">
        {cases.data?.map((c) => {
          const status = caseStatus(c);
          return (
            <li key={c.case_id} className="flex items-stretch gap-2">
              <button type="button" onClick={() => open(c, queryClient)} data-testid={`case-${c.display_id}`}
                      className={`min-w-0 flex-1 rounded border px-2 py-1 text-left text-xs ${
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
              <div className="flex shrink-0 items-center gap-1.5 text-xs">
                {confirmDelete === c.case_id ? (
                  <>
                    <span className="max-w-[14rem] text-right text-[11px] leading-tight text-red-800">
                      Delete {c.display_id} from this browser? A backup is kept.
                    </span>
                    <button type="button" data-testid={`case-delete-confirm-${c.display_id}`}
                            className="rounded-md bg-red-600 px-2.5 py-1 font-semibold text-white hover:bg-red-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700"
                            onClick={async () => {
                              setDeleteError(null);
                              try {
                                await deleteCase(c.case_id);
                                useStore.getState().closeSavedCase(c.case_id);
                              } catch (err) {
                                setDeleteError(storageErrorMessage(err));
                              }
                              setConfirmDelete(null);
                              await queryClient.invalidateQueries({ queryKey: ["cases"] });
                            }}>
                      Delete
                    </button>
                    <button type="button" onClick={() => setConfirmDelete(null)}
                            className="rounded-md px-2.5 py-1 font-semibold text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50">
                      Cancel
                    </button>
                  </>
                ) : (
                  <button type="button" data-testid={`case-delete-${c.display_id}`} aria-label={`Delete ${c.display_id}`}
                          onClick={() => setConfirmDelete(c.case_id)}
                          className="rounded-md bg-red-600 px-2.5 py-1 font-semibold text-white hover:bg-red-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700">
                    Delete
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
