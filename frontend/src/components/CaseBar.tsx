// Case workspace header + human review + Review Snapshot (plan §12A.1, .5, .6). Review status is derived; reviews
// and snapshots are immutable records bound to the exact stored analysis. Never an "accept diagnosis" button.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { DisplayAnalysis, Meta, PatientBundle } from "../api/client";
import { activeOutcomes, addOutcome, addReview, addSnapshot, caseStatus, clearDraft, currentAnalysis, currentScenario,
  getCase, outcomeBlocker, persistNewCase, reanalyzeCase, reviewsFor, saveDatasetCase, toDisplay,
  type OutcomeInput } from "../cases/caseStore";
import { storageErrorMessage } from "../cases/backup";
import { CORRECTION_REASONS, SOURCE_SYSTEMS, SOURCE_TYPES, type CaseRecord } from "../cases/db";
import { buildSnapshot, download, snapshotPdf } from "../cases/snapshot";
import { useStore } from "../store/useStore";

const SOURCE_LABEL = { dataset: "Dataset (OOF)", manual: "Manual entry", import: "Imported file" } as const;

function defaultLimitations(a: DisplayAnalysis): string[] {
  const out: string[] = [];
  if (Object.values(a.targets).some((t) => t?.model_confidence === "low")) out.push("Low model confidence");
  if (a.quality.atypical_profile.flag) out.push("Atypical profile");
  if ((a.quality.unknown_inputs ?? []).length) out.push("Unknown inputs (imputed, not measured)");
  return out;
}
const ALL_LIMITATIONS = ["Low model confidence", "Atypical profile", "Unknown inputs (imputed, not measured)",
  "Predicted-class conflict between targets", "Derived from a training record"];
const STATUS_STYLE = { "Unreviewed": "bg-amber-100 text-amber-900", "Reviewed": "bg-emerald-100 text-emerald-800",
  "Outcome recorded": "bg-sky-100 text-sky-900" } as const;
const STATUS_TEXT = { "Unreviewed": "Unreviewed", "Reviewed": "Review recorded",
  "Outcome recorded": "Outcome recorded (pending)" } as const;
const humanize = (s: string) => s.replaceAll("_", " ");

/** Record an angiographic outcome from the source record (plan §12B, Flow D step 1). Always stored as PENDING. */
function OutcomeForm({ record, meta, busy, onSubmit, onCancel }: {
  record: CaseRecord; meta: Meta; busy: boolean; onSubmit: (o: OutcomeInput) => void; onCancel: () => void }) {
  const live = activeOutcomes(record);
  const [labels, setLabels] = useState<Partial<Record<string, 0 | 1>>>({});
  const [sourceType, setSourceType] = useState<OutcomeInput["source_type"]>(SOURCE_TYPES[0]);
  const [sourceSystem, setSourceSystem] = useState<OutcomeInput["source_system"]>(SOURCE_SYSTEMS[0]);
  const [studyId, setStudyId] = useState("");
  const [reason, setReason] = useState<OutcomeInput["correction_reason"]>(null);
  const complete = meta.targets.every((t) => labels[t.id] === 0 || labels[t.id] === 1);
  const correcting = live.length > 0;
  return (
    <form className="space-y-1.5 border-t border-slate-100 pt-2" data-testid="outcome-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!complete || (correcting && !reason)) return;
            onSubmit({ labels: labels as OutcomeInput["labels"], source_type: sourceType, source_system: sourceSystem,
                       pseudonymous_study_id: studyId || null,
                       supersedes_outcome_id: correcting ? live[live.length - 1]!.outcome_id : null,
                       correction_reason: correcting ? reason : null });
          }}>
      <p className="font-semibold text-slate-700">{correcting ? "Correct the recorded outcome" : "Record angiographic outcome"}</p>
      <p className="text-[11px] text-slate-500">
        Enter the result from the source record (stenosis of 50% or more, per the dataset definitions), never the model
        output. Bound to this exact scenario (input {currentScenario(record).input_sha256.slice(0, 10)}…).
      </p>
      <table className="text-[11px]">
        <tbody>
          {meta.targets.map((t) => (
            <tr key={t.id} title={t.label_definition}>
              <td className="pr-2 font-medium text-slate-700">{t.display}</td>
              {([1, 0] as const).map((v) => (
                <td key={v} className="pr-2">
                  <label className="inline-flex items-center gap-1">
                    <input type="radio" name={`outcome-${t.id}`} checked={labels[t.id] === v}
                           data-testid={`outcome-${t.id}-${v}`} onChange={() => setLabels((p) => ({ ...p, [t.id]: v }))} />
                    {v ? "Positive" : "Negative"}
                  </label>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex flex-wrap gap-2 text-[11px]">
        <label>Source type{" "}
          <select value={sourceType} onChange={(e) => setSourceType(e.target.value as OutcomeInput["source_type"])}
                  className="rounded border border-slate-200">
            {SOURCE_TYPES.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
          </select>
        </label>
        <label>Source system{" "}
          <select value={sourceSystem} onChange={(e) => setSourceSystem(e.target.value as OutcomeInput["source_system"])}
                  className="rounded border border-slate-200">
            {SOURCE_SYSTEMS.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
          </select>
        </label>
        {correcting && (
          <label>Correction reason{" "}
            <select value={reason ?? ""} data-testid="outcome-correction-reason" className="rounded border border-slate-200"
                    onChange={(e) => setReason((e.target.value || null) as OutcomeInput["correction_reason"])}>
              <option value="">choose…</option>
              {CORRECTION_REASONS.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
            </select>
          </label>
        )}
        <label title="Optional. A random identifier assigned by the data owner; never derived from a name, MRN, date of birth or any other identifier (not even a hash of one).">
          Pseudonymous study ID (optional){" "}
          <input value={studyId} onChange={(e) => setStudyId(e.target.value)} maxLength={64}
                 className="w-28 rounded border border-slate-200 px-1" />
        </label>
      </div>
      <p className="rounded bg-sky-50 p-1.5 text-[11px] text-sky-900">
        Stored as <b>pending</b> in this browser. Nothing here can make it training data: only the model steward&apos;s
        offline verification (label definition, provenance, timing) can, and any model update still needs a validation
        gate and human approval. The model never learns from its own predictions.
      </p>
      <div className="flex gap-1">
        <button type="submit" disabled={busy || !complete || (correcting && !reason)} data-testid="outcome-save"
                className="rounded bg-sky-800 px-2 py-1 font-semibold text-white disabled:opacity-50">
          {correcting ? "Record correction (pending)" : "Record outcome (pending)"}
        </button>
        <button type="button" onClick={onCancel} className="rounded px-2 py-1 text-slate-600">Cancel</button>
      </div>
    </form>
  );
}

export function CaseBar({ analysis, meta }: { analysis: DisplayAnalysis; meta: Meta }) {
  const caseRef = useStore((s) => s.caseRef);
  const mode = useStore((s) => s.mode);
  const pending = useStore((s) => s.pendingCase);
  const editingCaseId = useStore((s) => s.editingCaseId);
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [note, setNote] = useState("");
  const [limitations, setLimitations] = useState<string[]>([]);
  const [recordingOutcome, setRecordingOutcome] = useState(false);
  const stored = useQuery({ queryKey: ["case", caseRef?.caseId], queryFn: () => getCase(caseRef!.caseId),
                            enabled: !!caseRef });
  const record = stored.data;

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
      await queryClient.invalidateQueries({ queryKey: ["cases"] });
      await queryClient.invalidateQueries({ queryKey: ["case"] });
    } catch (err) {
      setError(`${label} failed: ${storageErrorMessage(err)}. Nothing was saved.`);
    } finally {
      setBusy(null);
    }
  };

  const save = () => run("Saving", async () => {
    const st = useStore.getState();
    const c = mode === "dataset"
      ? await saveDatasetCase(analysis as unknown as PatientBundle)
      : await persistNewCase(pending!, editingCaseId ? (await getCase(editingCaseId)) ?? null : null);
    st.setCaseRef({ caseId: c.case_id, displayId: c.display_id });
    if (mode === "new") {
      st.setEditingCaseId(c.case_id);
      await clearDraft(); // the draft is now a saved scenario
    }
  });

  if (!caseRef) {
    const canSave = mode === "dataset" || (mode === "new" && pending);
    if (!canSave) return null;
    return (
      <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-2 text-xs text-slate-700" data-testid="case-bar">
        <div className="flex items-center justify-between gap-2">
          <span title="Saving stores predictions, explanations and evidence exactly as shown.">Unsaved analysis ⓘ</span>
          <button type="button" disabled={!!busy} onClick={() => void save()} data-testid="save-case"
                  className="shrink-0 rounded bg-slate-900 px-2 py-1 font-semibold text-white disabled:opacity-50">
            {busy ?? (editingCaseId ? "Save as new scenario" : "Save case")}
          </button>
        </div>
        {error && <p className="mt-1 text-red-700" role="alert">{error}</p>}
      </div>
    );
  }
  if (!record) return null;

  const stAnalysis = currentAnalysis(record);
  const scenario = currentScenario(record);
  const status = caseStatus(record);
  const reviews = reviewsFor(record, stAnalysis.analysis_id);
  const latestReview = reviews[reviews.length - 1] ?? null;
  const outdated = stAnalysis.model_version !== meta.model_version;

  const startReview = () => {
    setLimitations(latestReview?.limitations ?? defaultLimitations(analysis));
    setNote(latestReview?.note ?? "");
    setReviewing(true);
  };
  const saveReview = () => run("Recording review", async () => {
    await addReview(record.case_id, note.trim(), limitations);
    setReviewing(false);
  });
  const snapshot = () => run("Generating snapshot", async () => {
    const renderer = useStore.getState().snapshotRenderer;
    if (!renderer) throw new Error("3D view not ready");
    const st = useStore.getState();
    const preset = st.selectedTarget ? meta.anatomy_map && (meta.anatomy_map as { targets: Record<string, { camera_preset: string }> })
      .targets[st.selectedTarget]!.camera_preset : "overview";
    const image = renderer(preset ?? "overview");
    const storedSnapshot = await buildSnapshot(record, stAnalysis, latestReview, {
      png_data_url: image.png_data_url, camera: image.camera,
      view: { camera_preset: preset ?? "overview", target: st.selectedTarget, isolation: st.isolation,
              torso_visible: st.showBody, labels_visible: false },
    });
    await addSnapshot(record.case_id, storedSnapshot, stAnalysis.analysis_id, scenario.scenario_id);
    const base = `NOVARION Review Snapshot ${record.display_id}`;
    download(`${base}.pdf`, (await snapshotPdf(storedSnapshot)).output("blob"));
    download(`${base}.json`, new Blob([JSON.stringify(storedSnapshot, null, 1)], { type: "application/json" }));
  });

  return (
    <div className="space-y-2 rounded-lg border border-slate-300 bg-white p-2 text-xs" data-testid="case-bar">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <span className="font-bold text-slate-900" data-testid="case-id">{record.display_id}</span>
          <span className="ml-2 text-slate-500">
            {SOURCE_LABEL[record.source]}{record.dataset_patient_id ? ` · ${record.dataset_patient_id}` : ""} · scenario{" "}
            {record.scenarios.length}{scenario.kind === "edited" ? " (edited)" : ""}
          </span>
          <span data-testid="case-review-status" className={`ml-2 rounded px-1.5 py-0.5 font-semibold ${STATUS_STYLE[status]}`}>
            {STATUS_TEXT[status]}
          </span>
        </div>
        <div className="flex gap-1">
          <button type="button" onClick={startReview} data-testid="review-open"
                  className="rounded bg-white px-2 py-1 font-semibold text-slate-700 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50">
            {latestReview ? "Revise review" : "Review"}
          </button>
          {record.source !== "dataset" && (
            <button type="button" onClick={() => setRecordingOutcome((v) => !v)} data-testid="outcome-open"
                    disabled={!!outcomeBlocker(record, meta)} title={outcomeBlocker(record, meta) ?? undefined}
                    className="rounded bg-white px-2 py-1 font-semibold text-slate-700 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50 disabled:opacity-50">
              {record.outcomes?.length ? "Correct outcome" : "Record outcome"}
            </button>
          )}
          <button type="button" disabled={!!busy} onClick={() => void snapshot()} data-testid="snapshot"
                  className="rounded bg-slate-900 px-2 py-1 font-semibold text-white disabled:opacity-50">
            {busy === "Generating snapshot" ? "Generating…" : "Review Snapshot"}
          </button>
        </div>
      </div>
      {outdated && (
        <p className="rounded bg-sky-50 px-2 py-1 text-sky-900">
          Stored with model v{stAnalysis.model_version}; the current production model is v{meta.model_version}. This view
          shows the stored analysis exactly as it was.
          <button type="button" disabled={!!busy} data-testid="reanalyze"
                  className="ml-2 rounded bg-sky-800 px-2 py-0.5 font-semibold text-white disabled:opacity-50"
                  onClick={() => void run("Re-analyzing", async () => {
                    const updated = await reanalyzeCase(record.case_id);
                    useStore.getState().setAnalysis(toDisplay(currentAnalysis(updated)));
                  })}>
            Re-analyze with v{meta.model_version}
          </button>
        </p>
      )}
      {scenario.analyses.length > 1 && (
        <p className="text-slate-500">{scenario.analyses.length} analyses on this scenario (older ones kept)</p>
      )}
      {record.snapshots.length > 0 && (
        <p className="text-slate-500">
          {record.snapshots.length} snapshot{record.snapshots.length === 1 ? "" : "s"} · latest snapshot_sha256{" "}
          <code className="text-[10px]">{record.snapshots[record.snapshots.length - 1]!.stored_snapshot.snapshot_sha256.slice(0, 16)}…</code>
        </p>
      )}
      {record.outcomes?.length ? (
        <p className="text-slate-600" data-testid="outcome-summary">
          Outcome (pending verification):{" "}
          {meta.targets.map((t) => `${t.display} ${activeOutcomes(record).at(-1)!.labels[t.id] ? "positive" : "negative"}`)
            .join(" · ")}
          {record.outcomes.length > 1 ? ` · ${record.outcomes.length} records incl. corrections` : ""}
        </p>
      ) : null}
      {recordingOutcome && (
        <OutcomeForm record={record} meta={meta} busy={!!busy} onCancel={() => setRecordingOutcome(false)}
                     onSubmit={(o) => void run("Recording outcome", async () => {
                       await addOutcome(record.case_id, o, meta);
                       setRecordingOutcome(false);
                     })} />
      )}
      {reviewing && (
        <form className="space-y-1.5 border-t border-slate-100 pt-2" onSubmit={(e) => { e.preventDefault(); void saveReview(); }}
              data-testid="review-form">
          <label className="block font-semibold text-slate-700" htmlFor="review-note">What stood out?</label>
          <textarea id="review-note" value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={2000}
                    className="w-full rounded border border-slate-200 p-1.5"
                    placeholder="Your independent observations on the inputs and the model output (no identifiers)." />
          <fieldset>
            <legend className="font-semibold text-slate-700">Limitations that apply</legend>
            {ALL_LIMITATIONS.map((l) => (
              <label key={l} className="mr-3 inline-flex items-center gap-1 text-slate-600">
                <input type="checkbox" checked={limitations.includes(l)}
                       onChange={(e) => setLimitations((prev) => (e.target.checked ? [...prev, l] : prev.filter((x) => x !== l)))} />
                {l}
              </label>
            ))}
          </fieldset>
          <p className="text-[11px] text-slate-500">
            Records that a person reviewed the basis of this output. It does not accept or confirm any diagnosis; edits create
            a new review revision.
          </p>
          <div className="flex gap-1">
            <button type="submit" disabled={!!busy} data-testid="review-save"
                    className="rounded bg-emerald-700 px-2 py-1 font-semibold text-white disabled:opacity-50">
              Mark case reviewed
            </button>
            <button type="button" onClick={() => setReviewing(false)} className="rounded px-2 py-1 text-slate-600">Cancel</button>
          </div>
        </form>
      )}
      {error && <p className="text-red-700" role="alert">{error}</p>}
    </div>
  );
}
