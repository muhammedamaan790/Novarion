import { describe, expect, it } from "vitest";
import anatomyMap from "../../../config/anatomy_map.json";
import { intensity, rampColor, vesselColor, type ColorTransfer } from "./colors";

const transfer = anatomyMap.color_transfer as unknown as ColorTransfer;

describe("probability → colour transfer function (plan §11A)", () => {
  it("uses the operating threshold as the zero point of both families", () => {
    expect(intensity(0.55, 0.55)).toEqual({ family: "warm", i: 0 });
    const below = intensity(0.55 - 1e-9, 0.55);
    expect(below.family).toBe("cool");
    expect(below.i).toBeLessThan(1e-6);
  });

  it("reaches full intensity at the probability extremes", () => {
    expect(intensity(1, 0.55).i).toBe(1);
    expect(intensity(0, 0.55).i).toBe(1);
  });

  it("is monotone within each class", () => {
    const warm = [0.6, 0.7, 0.8, 0.9].map((p) => vesselColor(transfer, p, 0.55, false).oklch[0]);
    const cool = [0.5, 0.4, 0.3, 0.1].map((p) => vesselColor(transfer, p, 0.55, false).oklch[0]);
    for (const seq of [warm, cool]) {
      seq.slice(1).forEach((L, k) => expect(L).toBeLessThan(seq[k]!)); // deeper = darker
    }
  });

  it("pins the legend swatches (i = 0, .25, .5, .75, 1)", () => {
    const swatches = (["warm", "cool"] as const).map((f) =>
      [0, 0.25, 0.5, 0.75, 1].map((i) => rampColor(transfer, f, i, false).hex),
    );
    expect(swatches).toMatchSnapshot();
  });

  it("LOW confidence only reduces chroma", () => {
    const high = vesselColor(transfer, 0.8, 0.55, false);
    const low = vesselColor(transfer, 0.8, 0.55, true);
    expect(low.oklch[0]).toBe(high.oklch[0]);
    expect(low.oklch[1]).toBeCloseTo(high.oklch[1] * transfer.low_confidence_chroma_factor, 12);
  });

  it("produces valid sRGB hex", () => {
    for (const p of [0, 0.2, 0.549, 0.55, 0.9, 1]) {
      expect(vesselColor(transfer, p, 0.55, false).hex).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
