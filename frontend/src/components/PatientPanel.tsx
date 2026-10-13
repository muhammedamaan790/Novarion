// Dataset library page + the "Patient data" case tab, with the explicit ground-truth reveal (plan §12).
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { TARGET_IDS, api, type DisplayAnalysis, type Meta } from "../api/client";
import { useStore } from "../store/useStore";
import { GROUP_LABEL } from "./WhyPanel";
import { SHORT } from "./wording";

function GroundTruthReveal({ patientId }: { patientId: string }) {
  const [revealed, setRevealed] = useState(false);
  // Fetched only on reveal: ground truth is never in React state before the user asks (plan §11A).
  const truth = useQuery({ queryKey: ["truth", patientId], queryFn: () => api.groundTruth(patientId), enabled: revealed });
  if (!revealed) {
    return (
      <button type="button" onClick={() => setRevealed(true)} className="text-sm font-semibold text-slate-700 underline">
        Reveal angiography labels
      </button>
    );
  }
  if (!truth.data) return <p className="mt-2 text-xs text-slate-500">Loading labels…</p>;
  return (
    <div className="rounded-lg border border-slate-200 p-3 text-sm">
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

/** Full-page dataset library: search plus a grid of patients; opening one goes to its case workspace. */
export function DatasetLibrary() {
  const patients = useQuery({ queryKey: ["patients"], queryFn: api.patients });
  const [filter, setFilter] = useState("");
  const openDatasetPatient = useStore((s) => s.openDatasetPatient);
  const q = filter.trim().toLowerCase();
  const shown = (patients.data?.data.patients ?? []).filter((p) => !q
    || `${p.patient_id} ${p.sex} ${p.key_risk_factors.join(" ")}`.toLowerCase().includes(q.replaceAll(" ", "_"))
    || p.patient_id.toLowerCase().includes(q));
  return (
    <section aria-label="Dataset library" className="mx-auto w-full max-w-6xl p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-xl font-bold text-slate-900">Dataset library</h1>
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search by ID, sex or risk factor"
          aria-label="Filter dataset patients"
          className="w-full max-w-sm rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
        />
      </div>
      {patients.isError && <p className="mt-3 text-sm text-red-700">Could not load patients.</p>}
      <p className="mt-2 text-sm text-slate-600">{shown.length} patients</p>
      <ul className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {shown.map((p) => (
          <li key={p.patient_id}>
            <button
              type="button"
              data-testid={`patient-${p.patient_id}`}
              onClick={() => openDatasetPatient(p.patient_id)}
              className="h-full w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-left hover:border-slate-900"
            >
              <span className="text-sm font-bold text-slate-900">{p.patient_id}</span>
              <span className="text-sm text-slate-700"> · {p.age} y · {p.sex}</span>
              <span className="mt-0.5 block truncate text-xs text-slate-600">
                {p.key_risk_factors.length ? p.key_risk_factors.join(", ").replaceAll("_", " ") : "no listed risk factors"}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The "Patient data" tab: key findings first, every input one click away; dataset patients can reveal labels. */
export function PatientData({ meta, analysis }: { meta: Meta; analysis: DisplayAnalysis }) {
  const datasetPatientId = useStore((s) => s.datasetPatientId);
  const mode = useStore((s) => s.mode);
  const [showAll, setShowAll] = useState(false);
  const inputs = (analysis as DisplayAnalysis & { canonical_inputs?: Record<string, unknown> }).canonical_inputs;
  const features = meta.features.filter((f) => f.input_mode !== "constant");
  return (
    <section aria-label="Patient summary" className="mx-auto w-full max-w-3xl">
      {mode === "dataset" && datasetPatientId && <GroundTruthReveal key={datasetPatientId} patientId={datasetPatientId} />}
      {!inputs && <p className="text-sm text-slate-600">The inputs of this case are not stored with its analysis.</p>}
      {inputs && (showAll ? (
        <table className="mt-3 w-full text-sm">
          <tbody>
            {features.map((f) => (
              <tr key={f.id} className="border-t border-slate-100">
                <td className="py-1 pr-2 text-slate-700">{f.display}</td>
                <td className="py-1 text-right tabular-nums text-slate-900">{formatValue(f, inputs[f.id])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <KeyInputs features={features} inputs={inputs} />
      ))}
      {inputs && (
        <button type="button" onClick={() => setShowAll(!showAll)} data-testid="toggle-all-inputs"
                className="mt-3 text-sm font-semibold text-slate-700 underline">
          {showAll ? "Show key findings only" : `Show all ${features.length} inputs`}
        </button>
      )}
    </section>
  );
}

type Feature = Meta["features"][number];

/** A yes/no or category input counts as a finding when it is present (binary 1) or off its baseline category. */
function isFinding(f: Feature, v: unknown): boolean {
  if (v === "__UNKNOWN__") return true;
  if (f.kind === "binary") return v === 1;
  return f.kind !== "continuous" && String(v) !== String(f.categories?.[0] ?? "0");
}

/** Default inputs view: demographics in one line, only the positive findings per group, then the measurements.
 *  No normal-range flags: the feature registry has no clinical reference ranges, so none are invented here. */
function KeyInputs({ features, inputs }: { features: Feature[]; inputs: Record<string, unknown> }) {
  const demographics = features.filter((f) => f.group === "demographics");
  const categorical = features.filter((f) => f.group !== "demographics" && f.kind !== "continuous");
  const measurements = features.filter((f) => f.group !== "demographics" && f.kind === "continuous");
  const groups = [...new Set(categorical.map((f) => f.group))];
  return (
    <div className="mt-3 space-y-3 text-sm" data-testid="key-inputs">
      <p className="text-slate-800">
        {demographics.map((f) => (f.id === "bmi" ? `BMI ${formatValue(f, inputs[f.id])}` : formatValue(f, inputs[f.id]))).join(" · ")}
      </p>
      {groups.map((g) => {
        const found = categorical.filter((f) => f.group === g && isFinding(f, inputs[f.id]));
        const total = categorical.filter((f) => f.group === g).length;
        return (
          <div key={g}>
            <p className="font-semibold text-slate-600">{GROUP_LABEL[g] ?? g}</p>
            {found.length ? (
              <div className="mt-0.5 flex flex-wrap gap-1">
                {found.map((f) => (
                  <span key={f.id} className={`rounded px-2 py-0.5 font-medium ${
                    inputs[f.id] === "__UNKNOWN__" ? "border border-dashed border-slate-400 text-slate-600" : "bg-amber-50 text-amber-900"}`}>
                    {f.display}{f.kind === "binary" ? "" : `: ${formatValue(f, inputs[f.id])}`}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-slate-500">none of {total} present</p>
            )}
          </div>
        );
      })}
      <div>
        <p className="font-semibold text-slate-600">Measurements</p>
        <dl className="mt-1 grid grid-cols-1 gap-x-6 sm:grid-cols-2">
          {measurements.map((f) => (
            <div key={f.id} className="flex justify-between gap-1 border-t border-slate-100 py-px">
              <dt className="truncate text-slate-500" title={f.display}>{f.display}</dt>
              <dd className="shrink-0 tabular-nums text-slate-800">{formatValue(f, inputs[f.id])}</dd>
            </div>
          ))}
        </dl>
      </div>
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
