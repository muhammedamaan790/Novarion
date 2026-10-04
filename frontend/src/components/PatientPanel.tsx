// Left column: dataset library (labels hidden) + opened-patient summary + explicit ground-truth reveal (plan §12).
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { TARGET_IDS, api, type DisplayAnalysis, type Meta } from "../api/client";
import { useStore } from "../store/useStore";
import { MODE_BADGE, SHORT } from "./wording";

function GroundTruthReveal({ patientId }: { patientId: string }) {
  const [revealed, setRevealed] = useState(false);
  // Fetched only on reveal: ground truth is never in React state before the user asks (plan §11A).
  const truth = useQuery({ queryKey: ["truth", patientId], queryFn: () => api.groundTruth(patientId), enabled: revealed });
  if (!revealed) {
    return (
      <button type="button" onClick={() => setRevealed(true)} className="mt-2 text-xs text-slate-600 underline">
        Reveal angiography labels
      </button>
    );
  }
  if (!truth.data) return <p className="mt-2 text-xs text-slate-500">Loading labels…</p>;
  return (
    <div className="mt-2 rounded border border-slate-200 p-2 text-xs">
      <p className="font-semibold text-slate-700">Dataset angiography labels</p>
      <ul className="mt-1 grid grid-cols-2 gap-x-2">
        {TARGET_IDS.map((t) => (
          <li key={t}>
            {SHORT[t]}: {truth.data.data.labels[t] ? (t === "cad" ? "CAD" : "≥50% stenosis") : "normal"}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PatientPanel({ meta, analysis }: { meta: Meta; analysis: DisplayAnalysis | null }) {
  const patients = useQuery({ queryKey: ["patients"], queryFn: api.patients });
  const [filter, setFilter] = useState("");
  const datasetPatientId = useStore((s) => s.datasetPatientId);
  const openDatasetPatient = useStore((s) => s.openDatasetPatient);
  const bundle = analysis as (DisplayAnalysis & { canonical_inputs?: Record<string, unknown> }) | null;
  const inputs = bundle?.canonical_inputs;
  const features = meta.features.filter((f) => f.input_mode !== "constant");

  return (
    <div className="flex h-full flex-col gap-3 overflow-hidden">
      <section aria-label="Dataset library">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">Dataset library</h2>
        <p className="text-[11px] text-slate-500">Public cohort (UCI #411) · labels hidden until revealed</p>
        {patients.isError && <p className="mt-1 text-xs text-red-700">Could not load patients.</p>}
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by ID, sex or risk factor"
          aria-label="Filter dataset patients"
          className="mt-1 w-full rounded border border-slate-200 px-2 py-1 text-xs"
        />
        <ul className="mt-1 max-h-56 space-y-1 overflow-auto pr-1">
          {patients.data?.data.patients
            .filter((p) => {
              const q = filter.trim().toLowerCase();
              return !q || `${p.patient_id} ${p.sex} ${p.key_risk_factors.join(" ")}`.toLowerCase().includes(q.replaceAll(" ", "_"))
                || p.patient_id.toLowerCase().includes(q);
            })
            .map((p) => (
            <li key={p.patient_id}>
              <button
                type="button"
                data-testid={`patient-${p.patient_id}`}
                onClick={() => openDatasetPatient(p.patient_id)}
                className={`w-full rounded border px-2 py-1 text-left text-xs ${
                  datasetPatientId === p.patient_id ? "border-slate-900 bg-slate-50" : "border-slate-200 bg-white hover:bg-slate-50"
                }`}
              >
                <span className="font-semibold">{p.patient_id}</span> · {p.age} y · {p.sex}
                <span className="block truncate text-[10px] text-slate-500">
                  {p.key_risk_factors.length ? p.key_risk_factors.join(", ").replaceAll("_", " ") : "no listed risk factors"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      {analysis && datasetPatientId && (
        <section aria-label="Patient summary" className="min-h-0 flex-1 overflow-auto">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-slate-900">{datasetPatientId}</h2>
            <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-indigo-800">
              {MODE_BADGE[analysis.patient.prediction_mode]}
            </span>
          </div>
          <p className="text-[11px] text-slate-500">Out-of-fold result: this patient was not used to train the model shown.</p>
          <GroundTruthReveal key={datasetPatientId} patientId={datasetPatientId} />
          {inputs && (
            <table className="mt-2 w-full text-[11px]">
              <tbody>
                {features.map((f) => (
                  <tr key={f.id} className="border-t border-slate-100">
                    <td className="py-0.5 pr-2 text-slate-600">{f.display}</td>
                    <td className="py-0.5 text-right tabular-nums text-slate-800">
                      {formatValue(f, inputs[f.id])}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  );
}

function formatValue(f: Meta["features"][number], v: unknown): string {
  if (v === "__UNKNOWN__") return "UNKNOWN";
  if (f.kind === "binary") return f.categories?.length ? String(f.categories[Number(v)] ?? v) : v === 1 ? "Yes" : "No";
  if (f.kind === "continuous" && typeof v === "number") {
    const unit = f.canonical_unit ?? "";
    return `${v.toFixed(f.display_precision ?? 0)}${unit === "%" ? "" : " "}${unit}`.trim();
  }
  return String(v);
}
