// Review Snapshot (plan §12A.6): a reproducible software-generated analysis record — NOT a diagnostic report or medical
// record. Built ONLY from the stored analysis + stored review (never live UI state). Non-circular hash (plan §11):
// stored = { snapshot, snapshot_sha256 = SHA-256(JCS(snapshot)) }; the 3D image is embedded with its own image_sha256,
// so snapshot_sha256 covers the image too. The PDF and the JSON export are both rendered from the stored object.
import { jsPDF } from "jspdf";
import { REVISION as THREE_REVISION } from "three";
import { TARGET_IDS } from "../api/client";
import { CONFIDENCE_LABEL, DISCLAIMER, REASON_TEXT, SHORT, predictionText, probPct } from "../components/wording";
import type { CaseRecord, PersistedAnalysis, Review, StoredSnapshot } from "./db";
import { jcsSha256, sha256Hex } from "./jcs";

export const SNAPSHOT_SCHEMA_VERSION = "1.0.0";
export const STATEMENT = "A reproducible software-generated analysis record. Not a diagnostic report or medical record.";
export const SNAPSHOT_VIEWPORT = { width: 1600, height: 1000, dpr: 1 };
const MODEL_LIMITATIONS = [
  "Estimates the probability of the dataset's CAD / >=50% vessel-stenosis labels from routine clinical features.",
  "Trained and internally validated (nested cross-validation) on one public cohort of 303 patients; no external validation.",
  "Does not locate lesions: each vessel is tinted as a whole. Contributions are model associations, not causes.",
  "Model confidence reflects validation performance in this cohort, not clinical certainty.",
];

export interface SnapshotImage {
  png_data_url: string;
  view: { camera_preset: string; target: string | null; isolation: boolean; torso_visible: boolean; labels_visible: false };
  camera: Record<string, unknown>;
}

async function dataUrlSha256(dataUrl: string): Promise<string> {
  const b64 = dataUrl.split(",")[1] ?? "";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return sha256Hex(bytes);
}

async function assemble(c: CaseRecord, analysis: PersistedAnalysis, review: Review | null, image: SnapshotImage,
  createdAt: string) {
  const scenario = c.scenarios.find((s) => s.analyses.some((a) => a.analysis_id === analysis.analysis_id))!;
  const predictions: Record<string, unknown> = {};
  const explanations: Record<string, unknown> = {};
  const evidence: Record<string, unknown> = {};
  for (const t of TARGET_IDS) {
    const p = analysis.targets[t]!;
    predictions[t] = {
      label: p.label, predicted_class: p.predicted_class, probability: p.probability,
      operating_threshold: p.operating_threshold, model_confidence: p.model_confidence,
      model_confidence_reasons: p.model_confidence_reasons, evaluation_context: p.evaluation_context ?? null,
    };
    explanations[t] = (analysis.explanations[t]?.contributions ?? []).slice(0, 5).map((x) => ({
      measurement: x.display, value: x.display_value, direction: x.direction, strength: x.strength,
      contribution_calibrated_log_odds: x.contribution, value_status: x.value_status,
    }));
    evidence[t] = analysis.evidence[t]?.evidence_ledger ?? null;
  }
  const snapshot = {
    snapshot_schema_version: SNAPSHOT_SCHEMA_VERSION,
    kind: "NOVARION Review Snapshot",
    statement: STATEMENT,
    case: { case_id: c.case_id, display_id: c.display_id, source: c.source, dataset_patient_id: c.dataset_patient_id,
            scenario_id: scenario.scenario_id, scenario_kind: scenario.kind },
    analysis: {
      analysis_id: analysis.analysis_id,
      source_oof_analysis_id: "source_oof_analysis_id" in analysis ? analysis.source_oof_analysis_id : null,
      prediction_mode: analysis.patient.prediction_mode, app_version: analysis.app_version,
      model_version: analysis.model_version, preprocessing_version: analysis.preprocessing_version,
      training_data_sha256: analysis.training_data_sha256, artifact_manifest_sha256: analysis.artifact_manifest_sha256,
      reference_context_sha256: analysis.reference_context_sha256, input_sha256: analysis.input_sha256,
      anatomy_version: analysis.anatomy_version, anatomy_asset_sha256: analysis.anatomy_asset_sha256,
      stored_at: analysis.stored_at,
    },
    data_quality: {
      unknown_inputs: analysis.quality.unknown_inputs ?? [], unknown_input_count: (analysis.quality.unknown_inputs ?? []).length,
      atypical_profile: analysis.quality.atypical_profile, out_of_range_features: analysis.quality.out_of_range_features,
      notices: analysis.quality.notices,
    },
    predictions, top_contributions: explanations, evidence_ledger: evidence,
    review: review ? { review_id: review.review_id, note: review.note, limitations: review.limitations,
                       created_at: review.created_at } : null,
    model_limitations: MODEL_LIMITATIONS,
    image: { format: "png", image_sha256: await dataUrlSha256(image.png_data_url), data_url: image.png_data_url,
             snapshot_view: image.view },
    renderer: { renderer: "three.js WebGLRenderer (off-screen render target)", three_revision: THREE_REVISION,
                viewport: SNAPSHOT_VIEWPORT, camera: image.camera, lighting_rig: "novarion-default-v1",
                output_color_space: "srgb", background: "#f4f5f7", animation_time: "final material state (t = 0)",
                anatomy_asset_sha256: analysis.anatomy_asset_sha256 },
    created_at: createdAt,
    disclaimer: DISCLAIMER,
  };
  return snapshot;
}

export async function buildSnapshot(c: CaseRecord, analysis: PersistedAnalysis, review: Review | null,
  image: SnapshotImage, createdAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z")): Promise<StoredSnapshot> {
  const snapshot = await assemble(c, analysis, review, image, createdAt);
  return { snapshot, snapshot_sha256: await jcsSha256(snapshot) };
}

/** Recompute the hash of a stored snapshot (verification repeats the same steps on `snapshot` alone). */
export const verifySnapshot = async (stored: StoredSnapshot) => (await jcsSha256(stored.snapshot)) === stored.snapshot_sha256;

type Snap = Awaited<ReturnType<typeof assemble>>;

/** Display copy for the PDF only (keeps the file small); the hashed record keeps the exact PNG. */
async function toJpeg(pngDataUrl: string, quality = 0.88): Promise<string> {
  const img = new Image();
  img.src = pngDataUrl;
  await img.decode();
  const canvas = Object.assign(document.createElement("canvas"), { width: img.naturalWidth, height: img.naturalHeight });
  canvas.getContext("2d")!.drawImage(img, 0, 0);
  return canvas.toDataURL("image/jpeg", quality);
}

const DIRECTION_WORD = { up: "up", down: "down", neutral: "no effect" } as Record<string, string>;

export async function snapshotPdf(stored: StoredSnapshot): Promise<jsPDF> {
  const s = stored.snapshot as unknown as Snap;
  const jpeg = await toJpeg(s.image.data_url);
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const W = 210;
  const M = 14;
  let y = 16;
  const line = (text: string, size = 9, bold = false, gap = 1.5) => {
    doc.setFont("helvetica", bold ? "bold" : "normal").setFontSize(size);
    for (const part of doc.splitTextToSize(text, W - 2 * M) as string[]) {
      if (y > 272) {
        doc.addPage();
        y = 16;
      }
      doc.text(part, M, y);
      y += size * 0.42 + gap * 0.3;
    }
    y += gap;
  };
  line("NOVARION Review Snapshot", 16, true, 1);
  line(STATEMENT, 9, true);
  line(`Case ${s.case.display_id} · source: ${s.case.source}${s.case.dataset_patient_id ? ` (${s.case.dataset_patient_id})` : ""} · `
    + `scenario ${s.case.scenario_kind} · prediction mode: ${s.analysis.prediction_mode === "oof" ? "OOF validation" : "final production model"}`);
  line(`Created ${s.created_at} · model v${s.analysis.model_version} · app v${s.analysis.app_version} · `
    + `UNKNOWN inputs: ${s.data_quality.unknown_input_count} · atypical profile: ${s.data_quality.atypical_profile.flag ? "yes" : "no"}`);
  doc.addImage(jpeg, "JPEG", M, y, W - 2 * M, ((W - 2 * M) * SNAPSHOT_VIEWPORT.height) / SNAPSHOT_VIEWPORT.width);
  y += ((W - 2 * M) * SNAPSHOT_VIEWPORT.height) / SNAPSHOT_VIEWPORT.width + 4;
  line("Predictions (stored analysis; every number comes from the stored prediction)", 11, true);
  for (const t of TARGET_IDS) {
    const p = (s.predictions as Record<string, { predicted_class: string; probability: number; model_confidence: string;
      model_confidence_reasons: string[] }>)[t]!;
    const reasons = p.model_confidence_reasons.map((r) => REASON_TEXT[r] ?? r).join("; ");
    line(`${SHORT[t]}: ${predictionText(t, p as never)} · probability ${probPct(p.probability)} · `
      + `${CONFIDENCE_LABEL[p.model_confidence === "high" ? "high" : "low"]}${reasons ? ` (${reasons})` : ""}`);
  }
  line("Top model contributions (calibrated log-odds; associations, not causes)", 11, true);
  for (const t of TARGET_IDS) {
    const rows = (s.top_contributions as Record<string, { measurement: string; value: string; direction: string; strength: string }[]>)[t] ?? [];
    line(`${SHORT[t]}: ${rows.map((r) => `${r.measurement} = ${r.value} (${DIRECTION_WORD[r.direction] ?? r.direction}, ${r.strength})`).join("; ")}`, 8);
  }
  line("Human review", 11, true);
  if (s.review) {
    line(`Review recorded ${s.review.created_at}: ${s.review.note || "(no note)"}`);
    if (s.review.limitations.length) line(`Limitations noted: ${s.review.limitations.join("; ")}`);
  } else line("No review recorded for this analysis.");
  line("Model limitations", 11, true);
  for (const l of s.model_limitations) line(`• ${l}`, 8);
  line("Provenance", 11, true);
  line(`analysis_id ${s.analysis.analysis_id} · input_sha256 ${s.analysis.input_sha256} · training_data_sha256 `
    + `${s.analysis.training_data_sha256} · artifact_manifest_sha256 ${s.analysis.artifact_manifest_sha256} · image_sha256 `
    + `${s.image.image_sha256} · snapshot_sha256 ${stored.snapshot_sha256}`, 7);
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i).setFont("helvetica", "normal").setFontSize(7);
    doc.text(doc.splitTextToSize(`${DISCLAIMER} ${STATEMENT} snapshot_sha256 ${stored.snapshot_sha256} · page ${i}/${pages}`,
      W - 2 * M) as string[], M, 286);
  }
  return doc;
}

export function download(filename: string, data: Blob): void {
  const url = URL.createObjectURL(data);
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
