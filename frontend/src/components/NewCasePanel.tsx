// New case (plan §12 Screen 1 "New Case", §11A "Live-edit pipeline"): a form generated from the feature registry.
// Typing → instant client-side checks → 300 ms of quiet → one /validate + one /predict. Only the latest input
// revision may update the 3D view and panels; stale responses are discarded (AbortController + revision check).
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, type InputValue, type Meta, type ValidateResponse } from "../api/client";
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
      {f.canonical_unit && <span className="ml-1 text-slate-400">({f.canonical_unit})</span>}
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
  const revision = useRef(0);
  const inflight = useRef<AbortController | null>(null);
  const setAnalysis = useStore((s) => s.setAnalysis);
  const patients = useQuery({ queryKey: ["patients"], queryFn: api.patients });

  // Debounced validate → predict. Each edit bumps the revision; only the latest revision may commit.
  useEffect(() => {
    const filled = features.filter((f) => inputs[f.id] !== undefined && inputs[f.id] !== null).length;
    if (filled === 0) return;
    const rev = ++revision.current;
    const timer = window.setTimeout(async () => {
      inflight.current?.abort();
      const controller = new AbortController();
      inflight.current = controller;
      setStatus("updating");
      try {
        const v = await api.validate({ inputs, input_revision: rev, dataset_record_id: sourceRecord }, controller.signal);
        if (rev !== revision.current) return;
        setValidation(v.data);
        if (!v.data.ready) {
          setAnalysis(null); // fail closed: never keep colours from an older input
          setStatus("idle");
          return;
        }
        const p = await api.predict({ inputs, input_revision: rev }, controller.signal);
        if (rev !== revision.current || p.data.input_revision !== rev) return; // stale response: discard
        setAnalysis({ ...p.data, explanations: {}, evidence: {}, requestInputs: inputs });
        setStatus("idle");
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        if (rev === revision.current) {
          setAnalysis(null);
          setStatus(err instanceof ApiError || err instanceof Error ? "error" : "idle");
        }
      }
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [inputs, sourceRecord, features, setAnalysis]);

  const prefill = async (patientId: string) => {
    if (!patientId) return;
    const bundle = await api.patient(patientId);
    const values: Record<string, InputValue> = {};
    for (const f of features) values[f.id] = bundle.data.canonical_inputs[f.id] as InputValue;
    setSourceRecord(Number(patientId.slice(4)) - 1);
    setInputs(values);
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
      <select
        aria-label="Prefill from a dataset patient"
        className="rounded border border-slate-200 px-1.5 py-1 text-xs"
        defaultValue=""
        onChange={(e) => void prefill(e.target.value)}
      >
        <option value="">Prefill from a dataset patient…</option>
        {patients.data?.data.patients.map((p) => (
          <option key={p.patient_id} value={p.patient_id}>
            {p.patient_id} · {p.age} y · {p.sex}
          </option>
        ))}
      </select>

      <div role="status" className="rounded bg-slate-50 px-2 py-1 text-[11px] text-slate-700" data-testid="case-status">
        {missing > 0
          ? `${missing} field${missing === 1 ? "" : "s"} still required`
          : status === "updating"
            ? "Updating prediction…"
            : status === "error"
              ? "Analysis unavailable: no results shown."
              : blocks.length
                ? `Blocked: ${blocks.length} issue${blocks.length === 1 ? "" : "s"} to fix`
                : "Prediction up to date · edited case · production model"}
        {validation?.provenance.message && <span className="block text-slate-500">{validation.provenance.message}</span>}
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
              <Field key={f.id} f={f} value={inputs[f.id]} onChange={(v) => setInputs((prev) => ({ ...prev, [f.id]: v }))} />
            ))}
          </fieldset>
        ))}
      </form>
    </div>
  );
}
