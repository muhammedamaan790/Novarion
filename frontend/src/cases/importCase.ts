// Case import (plan §11 "Client-side responsibilities", §11A "Input semantics", "Identifier policy").
// Runs entirely in the browser BEFORE any network request: only registry-approved feature values can ever leave.
//   column matching: exact registry id → display name → declared alias (fuzzy matching disabled: HDL ≠ LDL ≠ LDH)
//   label columns (leakage denylist) are dropped and listed; unknown columns are dropped and listed
//   identifier columns: local mode → dropped + listed; hosted mode → the whole file is rejected
//   numbers: dot decimal only; thousands separators / locale formats are kept as text so the server BLOCKs them
//   units: "ldl [mg/dL]" or "ldl (mg/dL)" in the header declares the unit; a different unit is a unit mismatch
import type { InputValue, Meta } from "../api/client";

type Feature = Meta["features"][number];
export const UNKNOWN = "__UNKNOWN__";
export const MAX_BYTES = 1024 * 1024;
export const MAX_ROWS = 500;

const IDENTIFIER = new RegExp(
  "^(name|full_?name|first_?name|last_?name|surname|given_?name|patient_?name|mrn|medical_?record(_?(no|number))?|" +
    "hospital_?(id|number)|dob|date_?of_?birth|birth_?date|email|e_?mail|phone|telephone|mobile|address|street|" +
    "city|zip|zip_?code|postcode|post_?code|ssn|social_?security|nhs(_?number)?|aadhaar|passport|insurance_?(id|number))$",
);
const RECORD_COLUMNS = new Set(["dataset_record_id", "patient_id"]);
const UNKNOWN_WORDS = new Set(["unknown", "__unknown__", "?", "na", "n/a", "not measured"]);

export type UnitStatus = "explicit" | "canonical_assumed";

export interface ImportedRow {
  inputs: Record<string, InputValue>;
  unitStatus: Record<string, UnitStatus>;
  datasetRecordId: number | null;
  label: string;
}

export interface ImportReport {
  rows: ImportedRow[];
  recognized: { column: string; feature: string; unit: string | null }[];
  leakageDropped: string[];
  identifiersDropped: string[];
  unknownDropped: string[];
  unitMismatches: { column: string; declared: string; expected: string }[];
  rejected: string | null; // whole-file rejection reason (hosted identifier rule, size, format)
}

const norm = (s: string) => s.normalize("NFC").trim();
const key = (s: string) => norm(s).toLowerCase().replace(/[\s-]+/g, "_");

/** Split "LDL [mg/dL]" → {name: "LDL", unit: "mg/dL"}. */
export function splitHeader(header: string): { name: string; unit: string | null } {
  const m = norm(header).match(/^(.*?)\s*[[(]\s*([^\])]+?)\s*[\])]\s*$/);
  return m ? { name: m[1]!, unit: m[2]! } : { name: norm(header), unit: null };
}

/** RFC 4180 CSV (quoted fields, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((v) => v.trim() !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  row.push(field);
  if (row.some((v) => v.trim() !== "")) rows.push(row);
  return rows;
}

function matchFeature(name: string, features: Feature[]): Feature | undefined {
  return (
    features.find((f) => f.id === name) ??
    features.find((f) => f.display === name) ??
    features.find((f) => (f.aliases ?? []).includes(name))
  );
}

export function parseValue(f: Feature, raw: unknown): InputValue {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : String(raw);
  if (typeof raw === "boolean") return String(raw); // never silently 0/1: the server rejects it with a clear issue
  const s = norm(String(raw));
  if (s === "") return null;
  if (UNKNOWN_WORDS.has(s.toLowerCase())) return f.allow_unknown ? UNKNOWN : s;
  const tokens = f.import_tokens ?? {};
  if (f.kind === "continuous") return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : s; // "1,250" / "4,5" stay text → BLOCK
  if (s in tokens) return tokens[s] as InputValue;
  if (f.kind === "binary") {
    if (s === "0" || s === "1") return Number(s); // the canonical encoding is always accepted
    const lower = s.toLowerCase();
    if (["1", "yes", "y", "true"].includes(lower) && !f.categories?.length) return 1;
    if (["0", "no", "n", "false"].includes(lower) && !f.categories?.length) return 0;
    const idx = (f.categories ?? []).findIndex((c) => c.toLowerCase() === lower);
    if (idx >= 0) return idx; // e.g. sex: female = 0, male = 1
    return s;
  }
  return s; // ordinal / nominal: exact registry token, otherwise the server reports an unseen category
}

function recordId(raw: unknown): number | null {
  const s = norm(String(raw ?? ""));
  const zas = s.match(/^ZAS-(\d{4})$/i);
  if (zas) return Number(zas[1]) - 1;
  return /^\d+$/.test(s) ? Number(s) : null;
}

export function importRecords(records: Record<string, unknown>[], meta: Meta, sizeBytes: number): ImportReport {
  const report: ImportReport = {
    rows: [], recognized: [], leakageDropped: [], identifiersDropped: [], unknownDropped: [], unitMismatches: [],
    rejected: null,
  };
  if (sizeBytes > MAX_BYTES) return { ...report, rejected: "File is larger than 1 MB." };
  if (records.length === 0) return { ...report, rejected: "No rows found." };
  if (records.length > MAX_ROWS) return { ...report, rejected: `More than ${MAX_ROWS} rows.` };
  const features = meta.features;
  const leakage = new Set((meta.leakage_denylist ?? []).map((c) => c.toLowerCase()));
  const columns = [...new Set(records.flatMap((r) => Object.keys(r)))];
  const mapping = new Map<string, { feature: Feature; unit: string | null }>();
  for (const column of columns) {
    const { name, unit } = splitHeader(column);
    if (RECORD_COLUMNS.has(key(name))) continue;
    if (leakage.has(name.toLowerCase())) {
      report.leakageDropped.push(column);
      continue;
    }
    if (IDENTIFIER.test(key(name))) {
      report.identifiersDropped.push(column);
      continue;
    }
    const feature = matchFeature(name, features);
    if (!feature || feature.input_mode === "constant") {
      if (!feature) report.unknownDropped.push(column);
      continue;
    }
    if (unit && feature.canonical_unit && unit.toLowerCase() !== feature.canonical_unit.toLowerCase()) {
      report.unitMismatches.push({ column, declared: unit, expected: feature.canonical_unit });
    }
    mapping.set(column, { feature, unit });
    report.recognized.push({ column, feature: feature.id, unit });
  }
  if (report.identifiersDropped.length && meta.run_mode !== "local") {
    return {
      ...report, rows: [],
      rejected: `Identifier column(s) found (${report.identifiersDropped.join(", ")}). The hosted demo accepts ` +
        "de-identified files only; remove them or run NOVARION locally.",
    };
  }
  records.forEach((record, i) => {
    const inputs: Record<string, InputValue> = {};
    const unitStatus: Record<string, UnitStatus> = {};
    for (const [column, { feature, unit }] of mapping) {
      if (feature.id in inputs && inputs[feature.id] !== null) continue; // first matching column wins
      const value = parseValue(feature, record[column]);
      // a unit that does not match the canonical unit is never converted silently: the value is withheld
      const mismatch = report.unitMismatches.some((m) => m.column === column);
      inputs[feature.id] = mismatch ? null : value;
      if (!mismatch && feature.kind === "continuous" && feature.input_mode === "entered" && typeof value === "number") {
        unitStatus[feature.id] = unit ? "explicit" : "canonical_assumed";
      }
    }
    const rid = recordId(record["dataset_record_id"] ?? record["patient_id"]);
    report.rows.push({ inputs, unitStatus, datasetRecordId: rid, label: rid != null ? `ZAS-${String(rid + 1).padStart(4, "0")}` : `row ${i + 1}` });
  });
  return report;
}

export async function readCaseFile(file: File, meta: Meta): Promise<ImportReport> {
  const text = await file.text();
  try {
    if (file.name.toLowerCase().endsWith(".json")) {
      const data = JSON.parse(text) as unknown;
      const list = Array.isArray(data) ? data : [data];
      const records = list.map((d) => {
        const r = d as Record<string, unknown>;
        return r.inputs && typeof r.inputs === "object"
          ? { ...(r.inputs as Record<string, unknown>), dataset_record_id: r.dataset_record_id } : r;
      });
      return importRecords(records, meta, file.size);
    }
    const [header, ...body] = parseCsv(text);
    if (!header) return importRecords([], meta, file.size);
    const records = body.map((cells) => Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""])));
    return importRecords(records, meta, file.size);
  } catch {
    return { ...importRecords([], meta, 0), rejected: "The file could not be parsed as CSV or JSON." };
  }
}
