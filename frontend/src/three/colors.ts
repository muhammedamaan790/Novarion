// Probability → vessel colour (plan §9.3, §11A). Colour family = predicted class; depth = class-relative distance
// from the operating threshold. NOT a linear probability scale. Endpoints come from anatomy_map.color_transfer.

export type Oklch = [number, number, number]; // L (0–1), C, h (degrees)

export interface ColorTransfer {
  warm: { light: Oklch; deep: Oklch };
  cool: { light: Oklch; deep: Oklch };
  low_confidence_chroma_factor: number;
}

export interface VesselColor {
  family: "warm" | "cool";
  intensity: number; // i in [0, 1]
  oklch: Oklch;
  linear: [number, number, number]; // linear sRGB, for three.js materials
  hex: string; // sRGB hex, for CSS (legend, cards)
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Class-relative intensity (§11A): positive i = (p − t_op)/(1 − t_op); negative i = (t_op − p)/t_op. */
export function intensity(p: number, tOp: number): { family: "warm" | "cool"; i: number } {
  if (p >= tOp) return { family: "warm", i: tOp >= 1 ? 1 : clamp01((p - tOp) / (1 - tOp)) };
  return { family: "cool", i: tOp <= 0 ? 1 : clamp01((tOp - p) / tOp) };
}

export function oklchToLinearSrgb([L, C, h]: Oklch): [number, number, number] {
  const a = C * Math.cos((h * Math.PI) / 180);
  const b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    clamp01(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    clamp01(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    clamp01(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

const encode = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);

export function linearToHex(rgb: [number, number, number]): string {
  return `#${rgb.map((x) => Math.round(encode(x) * 255).toString(16).padStart(2, "0")).join("")}`;
}

export function rampColor(transfer: ColorTransfer, family: "warm" | "cool", i: number, lowConfidence: boolean
): VesselColor {
  const { light, deep } = transfer[family];
  const L = light[0] - i * (light[0] - deep[0]);
  const C = (light[1] + i * (deep[1] - light[1])) * (lowConfidence ? transfer.low_confidence_chroma_factor : 1);
  const h = light[2] + i * (deep[2] - light[2]);
  const linear = oklchToLinearSrgb([L, C, h]);
  return { family, intensity: i, oklch: [L, C, h], linear, hex: linearToHex(linear) };
}

export function vesselColor(transfer: ColorTransfer, p: number, tOp: number, lowConfidence: boolean): VesselColor {
  const { family, i } = intensity(p, tOp);
  return rampColor(transfer, family, i, lowConfidence);
}

/** Neutral anatomy grey, shown until a complete analysis exists (never partial colours, plan §12). */
export const NEUTRAL_LINEAR: [number, number, number] = oklchToLinearSrgb([0.78, 0.005, 250]);
// Light, low-chroma tissue tone so the warm (stenosis) family on the vessels stays distinct from the muscle.
export const MYOCARDIUM_LINEAR: [number, number, number] = oklchToLinearSrgb([0.8, 0.018, 45]);
