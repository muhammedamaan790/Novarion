// New case (plan §12 Screen 1 "New Case", §11A "Live-edit pipeline"): a form generated from the feature registry.
// Typing → instant client-side checks → 300 ms of quiet → one /validate + one /predict. Only the latest input
// revision may update the 3D view and panels; stale responses are discarded (AbortController + revision check).
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, TARGET_IDS, api, type InputValue, type Meta, type ValidateResponse } from "../api/client";
import { clearDraft, loadDraft, scheduleDraft } from "../cases/caseStore";
import type { DraftRecord } from "../cases/db";
import { readCaseFile, type ImportedRow, type ImportReport, type UnitStatus } from "../cases/importCase";
import { useStore } from "../store/useStore";
import { MODE_BADGE } from "./wording";

type Feature = Meta["features"][number];
const UNKNOWN = "__UNKNOWN__";
const GROUP_LABEL: Record<string, string> = {
  demographics: "Demographics", history: "History / risk factors", symptoms_exam: "Symptoms & exam",
  ecg: "ECG", labs: "Labs", echo: "Echo",
};
const DEBOUNCE_MS = 300;

function Field({ f, value, onChange }: { f: Feature; value: InputValue | undefined; onChange: (v: InputValue) => void }) {
  const id = `field-${f.id}`;
  const blank = value === undefined || value === null || value === "";
  const label = (
    <label htmlFor={id} className="truncate text-slate-700" title={f.display}>
      {f.display}
      {f.canonical_unit && <span className="ml-1 text-slate-500">({f.canonical_unit})</span>}
    </label>
  );
  const cls = `w-full rounded border px-1.5 py-0.5 text-xs ${blank ? "border-amber-400 bg-amber-50" : "border-slate-200"}`;
  if (f.kind === "continuous") {
    const isUnknown = value === UNKNOWN;
    return (
      <div className="grid grid-cols-[1fr_6.5rem] items-center gap-2 text-xs">
        {label}
        <div className="flex items-center gap-1">
          <input
            id={id}
            type="number"
            inputMode="decimal"
            step="any"
            min={f.hard_valid_range?.[0]}
            max={f.hard_valid_range?.[1]}
            disabled={isUnknown}
            value={isUnknown || blank ? "" : String(value)}
            onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
            className={cls}
            data-testid={id}
          />
          {f.allow_unknown && (
            <button
              type="button"
              title="Mark as UNKNOWN (imputed, forces LOW model confidence)"
              aria-label={`${isUnknown ? "Clear UNKNOWN for" : "Mark UNKNOWN for"} ${f.display}`}
              aria-pressed={isUnknown}
              onClick={() => onChange(isUnknown ? null : UNKNOWN)}
              className={`rounded px-1 text-[10px] ${isUnknown ? "bg-slate-700 text-white" : "bg-slate-100 text-slate-600"}`}
            >
              ?
            </button>
          )}
        </div>
      </div>
    );
  }
  const options: { value: string; label: string }[] =
    f.kind === "binary"
      ? (f.categories?.length ? f.categories : ["No", "Yes"]).map((c, i) => ({ value: String(i), label: String(c) }))
      : (f.categories ?? []).map((c) => ({ value: c, label: c }));
  const current = blank ? "" : value === UNKNOWN ? UNKNOWN : String(value);
  return (
    <div className="grid grid-cols-[1fr_6.5rem] items-center gap-2 text-xs">
      {label}
      <select
        id={id}
        value={current}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v === "" ? null : v === UNKNOWN ? UNKNOWN : f.kind === "binary" ? Number(v) : v);
        }}
        className={cls}
        data-testid={id}
      >
        <option value="">— required —</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
        {f.allow_unknown && <option value={UNKNOWN}>UNKNOWN</option>}
      </select>
    </div>
  );
}

export function NewCasePanel({ meta }: { meta: Meta }) {
  const features = useMemo(() => meta.features.filter((f) => f.input_mode === "entered"), [meta]);
  const [inputs, setInputs] = useState<Record<string, InputValue>>({});
  const [sourceRecord, setSourceRecord] = useState<number | null>(null);
  const [validation, setValidation] = useState<ValidateResponse | null>(null);
  const [status, setStatus] = useState<"idle" | "updating" | "error">("idle");
  const [unitStatus, setUnitStatus] = useState<Record<string, UnitStatus>>({});
  const [report, setReport] = useState<ImportReport | null>(null);
  const [pickedRow, setPickedRow] = useState<string>("");
  const fileInput = useRef<HTMLInputElement>(null);
  const sourceKind = useRef<"manual" | "import">("manual");
  const [recoverable, setRecoverable] = useState<DraftRecord | null>(null);

  // Draft recovery (plan §1): an unsaved draft from an earlier visit is offered, never applied silently.
  useEffect(() => {
    let alive = true;
    void loadDraft().then((d) => { if (alive && d) setRecoverable(d); }).catch(() => undefined);
    return () => { alive = false; };
  }, []);

  // Autosave the current draft (debounced). It stays a recoverable draft until "Save case" turns it into a scenario.
  useEffect(() => {
    if (!Object.values(inputs).some((v) => v !== null && v !== undefined)) return;
    scheduleDraft({ inputs, unit_status: unitStatus, dataset_record_id: sourceRecord, source: sourceKind.current });
  }, [inputs, unitStatus, sourceRecord]);

  const recover = () => {
    if (!recoverable) return;
    sourceKind.current = recoverable.source;
    setSourceRecord(recoverable.dataset_record_id);
    setUnitStatus(recoverable.unit_status as Record<string, UnitStatus>);
    setInputs(recoverable.inputs);
    setRecoverable(null);
  };
  const discard = () => {
    void clearDraft();
    setRecoverable(null);
  };
  const revision = useRef(0);
  const inflight = useRef<AbortController | null>(null);
  const [prefillId, setPrefillId] = useState("");
  const [prefillStatus, setPrefillStatus] = useState<"idle" | "loading" | "error">("idle");
  const prefillRequest = useRef<AbortController | null>(null);
  const analysis = useStore((s) => s.analysis);
  const setAnalysis = useStore((s) => s.setAnalysis);
  const patients = useQuery({ queryKey: ["patients"], queryFn: api.patients });

  // Leaving the panel invalidates every in-flight request: a late response must never overwrite the analysis of
  // whatever the user opened next (e.g. "Open the out-of-fold result").
  useEffect(() => {
    const revisionRef = revision;
    const inflightRef = inflight;
    const prefillRef = prefillRequest;
    return () => {
      revisionRef.current += 1;
      inflightRef.current?.abort();
      prefillRef.current?.abort();
    };
  }, []);

  // Debounced validate → predict. Each edit bumps the revision; only the latest revision may commit.
  useEffect(() => {
    const rev = ++revision.current;
    inflight.current?.abort();
    const controller = new AbortController();
    inflight.current = controller;
    if (useStore.getState().mode === "new") setAnalysis(null); // an edited input never keeps the old prediction
    const filled = features.filter((f) => inputs[f.id] !== undefined && inputs[f.id] !== null).length;
    if (filled === 0) return () => controller.abort();
    const timer = window.setTimeout(async () => {
      setStatus("updating");
      try {
        const v = await api.validate(
          { inputs, unit_status: unitStatus, input_revision: rev, dataset_record_id: sourceRecord }, controller.signal);
        if (rev !== revision.current) return;
        setValidation(v.data);
        if (!v.data.ready) {
          if (useStore.getState().mode !== "new") return;
          setAnalysis(null); // fail closed: never keep colours from an older input
          setStatus("idle");
          return;
        }
        const p = await api.predict({ inputs, unit_status: unitStatus, input_revision: rev }, controller.signal);
        if (rev !== revision.current || p.data.input_revision !== rev) return; // stale response: discard
        if (useStore.getState().mode !== "new") return; // the user has left the new-case workflow
        if (!TARGET_IDS.every((t) => p.data.targets?.[t])) throw new Error("Incomplete prediction response");
        setAnalysis({ ...p.data, explanations: {}, evidence: {}, requestInputs: inputs });
        const st = useStore.getState();
        st.setCaseRef(null); // a new transient analysis is not saved yet ("Save as new scenario")
        st.setPendingCase({ inputs, unitStatus, canonicalInputs: v.data.canonical_inputs ?? null,
                            datasetRecordId: sourceRecord, source: sourceKind.current });
        setStatus("idle");
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        if (rev === revision.current) {
          setAnalysis(null);
          setStatus(err instanceof ApiError || err instanceof Error ? "error" : "idle");
        }
      }
    }, DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [inputs, unitStatus, sourceRecord, features, setAnalysis]);

  const cancelPrefill = () => {
    prefillRequest.current?.abort();
    prefillRequest.current = null;
    setPrefillStatus("idle");
  };

  const prefill = async (patientId: string) => {
    prefillRequest.current?.abort();
    const controller = new AbortController();
    prefillRequest.current = controller;
    setPrefillId(patientId);
    setValidation(null);
    setInputs({});
    setSourceRecord(null);
    setPrefillStatus(patientId ? "loading" : "idle");
    if (!patientId) return;
    try {
      const bundle = await api.patient(patientId, controller.signal);
      if (controller.signal.aborted || prefillRequest.current !== controller) return;
      const values: Record<string, InputValue> = {};
      for (const f of features) values[f.id] = bundle.data.canonical_inputs[f.id] as InputValue;
      setSourceRecord(Number(patientId.slice(4)) - 1);
      sourceKind.current = "manual";
      setUnitStatus({});
      setReport(null);
      setInputs(values);
      setPrefillStatus("idle");
    } catch {
      if (!controller.signal.aborted && prefillRequest.current === controller) setPrefillStatus("error");
    }
  };

  const loadRow = (row: ImportedRow) => {
    cancelPrefill();
    const values: Record<string, InputValue> = {};
    for (const f of features) values[f.id] = row.inputs[f.id] ?? null;
    setSourceRecord(row.datasetRecordId);
    sourceKind.current = "import";
    setUnitStatus(row.unitStatus);
    setInputs(values);
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    const r = await readCaseFile(file, meta);
    setReport(r);
    setPickedRow("");
    if (!r.rejected && r.rows.length === 1) loadRow(r.rows[0]!);
    if (fileInput.current) fileInput.current.value = "";
  };

  const assumed = features.filter((f) => unitStatus[f.id] === "canonical_assumed");
  const editField = (id: string, v: InputValue) => {
    cancelPrefill(); // a late prefill must never overwrite the user's manual edit
    setUnitStatus((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id]; // typed in the form, next to its unit label → explicit
      return next;
    });
    setInputs((prev) => ({ ...prev, [id]: v }));
  };

  const groups = useMemo(() => {
    const out: Record<string, Feature[]> = {};
    for (const f of features) (out[f.group] ??= []).push(f);
    return Object.entries(out);
  }, [features]);
  const missing = features.filter((f) => inputs[f.id] === undefined || inputs[f.id] === null).length;
  const blocks = validation?.items.filter((i) => i.severity === "BLOCK") ?? [];
  const warnings = validation?.items.filter((i) => i.severity === "WARN") ?? [];

  return (
    <div className="flex h-full flex-col gap-2 overflow-hidden">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">New case</h2>
        <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-emerald-800">
          {MODE_BADGE.final_model}
        </span>
      </div>
      <p className="text-[11px] text-slate-500">
        De-identified or synthetic values only. Every field needs a value
        {" "}or an explicit UNKNOWN (where allowed). BMI and obesity are computed.
      </p>
      {recoverable && (
        <div className="rounded border border-sky-300 bg-sky-50 p-2 text-[11px] text-sky-900" data-testid="draft-recovery">
          <p>Recover unsaved draft from {recoverable.saved_at.replace("T", " ").replace("Z", " UTC")}?</p>
          <div className="mt-1 flex gap-1">
            <button type="button" onClick={recover} data-testid="draft-recover"
                    className="rounded bg-sky-800 px-2 py-0.5 font-semibold text-white">Recover</button>
            <button type="button" onClick={discard} data-testid="draft-discard"
                    className="rounded px-2 py-0.5 text-sky-900 ring-1 ring-sky-300">Discard</button>
          </div>
        </div>
      )}
      <select
        aria-label="Prefill from a dataset patient"
        className="rounded border border-slate-200 px-1.5 py-1 text-xs"
        value={prefillId}
        onChange={(e) => void prefill(e.target.value)}
      >
        <option value="">Prefill from a dataset patient…</option>
        {patients.data?.data.patients.map((p) => (
          <option key={p.patient_id} value={p.patient_id}>
            {p.patient_id} · {p.age} y · {p.sex}
          </option>
        ))}
      </select>
      <div className="flex items-center gap-2 text-[11px]">
        <button type="button" onClick={() => fileInput.current?.click()} data-testid="import-button"
                className="rounded bg-slate-900 px-2 py-1 font-semibold text-white hover:bg-slate-700">
          Import CSV / JSON…
        </button>
        <input ref={fileInput} type="file" accept=".csv,.json,text/csv,application/json" className="hidden"
               data-testid="import-file" onChange={(e) => void onFile(e.target.files?.[0])} />
        <span className="text-slate-500">
          samples:{" "}
          <a className="underline" href="/samples/novarion_case_template.csv" download>template</a>{" · "}
          <a className="underline" href="/samples/dataset_patient_ZAS-0003.csv" download>dataset patient</a>{" · "}
          <a className="underline" href="/samples/synthetic_case.json" download>synthetic</a>
        </span>
      </div>
      {report && (
        <div className="rounded border border-slate-200 p-2 text-[11px] text-slate-700" data-testid="import-report">
          {report.rejected ? (
            <p className="font-medium text-red-700">Import rejected: {report.rejected}</p>
          ) : (
            <>
              <p>
                Recognized {report.recognized.length} field{report.recognized.length === 1 ? "" : "s"}
                {report.rows.length > 1 ? ` · ${report.rows.length} rows` : ""}. Only these values leave the browser.
              </p>
              {report.leakageDropped.length > 0 && (
                <p>Leakage fields ignored (outcome labels are never model inputs): {report.leakageDropped.join(", ")}</p>
              )}
              {report.identifiersDropped.length > 0 && (
                <p>Identifier columns dropped locally: {report.identifiersDropped.join(", ")}</p>
              )}
              {report.unknownDropped.length > 0 && <p>Unrecognized columns ignored: {report.unknownDropped.join(", ")}</p>}
              {report.unitMismatches.map((m) => (
                <p key={m.column} className="text-red-700">
                  {m.column}: unit {m.declared} differs from {m.expected}; value withheld (no silent conversion).
                </p>
              ))}
              {report.rows.length > 1 && (
                <select aria-label="Choose one row" value={pickedRow} data-testid="import-row"
                        className="mt-1 w-full rounded border border-slate-200 px-1 py-0.5"
                        onChange={(e) => {
                          setPickedRow(e.target.value);
                          const row = report.rows[Number(e.target.value)];
                          if (row) loadRow(row);
                        }}>
                  <option value="">Choose one row (one row = one case)…</option>
                  {report.rows.map((r, i) => <option key={i} value={i}>{r.label}</option>)}
                </select>
              )}
            </>
          )}
        </div>
      )}
      {assumed.length > 0 && (
        <div className="rounded border border-amber-300 bg-amber-50 p-2 text-[11px] text-amber-900" data-testid="unit-confirm">
          <p>
            No unit in the file for: {assumed.map((f) => `${f.display} (${f.canonical_unit})`).join(", ")}. Values in
            other units (for example mmol/L) would be wrong.
          </p>
          <button type="button" className="mt-1 rounded bg-amber-700 px-2 py-0.5 font-semibold text-white"
                  onClick={() => setUnitStatus({})}>
            I confirm these values are in the units shown
          </button>
        </div>
      )}

      <div role="status" className="rounded bg-slate-50 px-2 py-1 text-[11px] text-slate-700" data-testid="case-status">
        {prefillStatus === "loading" ? "Loading selected patient…"
          : prefillStatus === "error" ? "Could not load the selected patient. No results shown; retry or enter values."
          : missing > 0
          ? `${missing} field${missing === 1 ? "" : "s"} still required`
          : status === "updating"
            ? "Updating prediction…"
            : status === "error"
              ? "Analysis unavailable: no results shown."
              : blocks.length
                ? `Blocked: ${blocks.length} issue${blocks.length === 1 ? "" : "s"} to fix`
                : analysis ? "Prediction up to date · edited case · production model" : "Waiting for analysis…"}
        {validation?.provenance.message && <span className="block text-slate-500">{validation.provenance.message}</span>}
        {validation?.provenance.prediction_mode === "oof" && sourceRecord != null && (
          <button type="button" className="mt-1 underline" data-testid="open-oof"
                  onClick={() => useStore.getState().openDatasetPatient(`ZAS-${String(sourceRecord + 1).padStart(4, "0")}`)}>
            Open the out-of-fold result for this dataset record
          </button>
        )}
      </div>
      {(blocks.length > 0 || warnings.length > 0) && (
        <ul className="max-h-24 overflow-auto text-[11px]">
          {[...blocks, ...warnings].map((i, k) => (
            <li key={k} className={i.severity === "BLOCK" ? "text-red-700" : "text-amber-800"}>
              {i.severity} · {features.find((f) => f.id === i.feature_id)?.display ?? i.feature_id ?? "case"}: {i.message}
            </li>
          ))}
        </ul>
      )}

      <form className="min-h-0 flex-1 space-y-3 overflow-auto pr-1" onSubmit={(e) => e.preventDefault()}>
        {groups.map(([group, fs]) => (
          <fieldset key={group} className="space-y-1">
            <legend className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              {GROUP_LABEL[group] ?? group}
            </legend>
            {fs.map((f) => (
              <Field key={f.id} f={f} value={inputs[f.id]} onChange={(v) => editField(f.id, v)} />
            ))}
          </fieldset>
        ))}
      </form>
    </div>
  );
}
