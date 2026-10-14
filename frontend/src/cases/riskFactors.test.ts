import { describe, expect, it } from "vitest";
import type { Contribution } from "../api/client";
import { RULE_INPUTS, riskFactors } from "./riskFactors";

const c = (feature: string, value: number | string, status: Contribution["value_status"] = "provided") =>
  ({ feature, value, value_status: status }) as Contribution;
const healthy = [
  c("current_smoker", 0), c("diabetes", 0), c("fasting_blood_sugar", 92), c("hypertension", 0), c("blood_pressure", 120),
  c("dyslipidemia", 0), c("ldl", 100), c("hdl", 50), c("triglycerides", 120), c("bmi", 22.5, "computed"),
];
const ids = (cs: Contribution[]) => riskFactors(cs).found.map((r) => r.id);
const replace = (feature: string, x: Contribution) => healthy.map((h) => (h.feature === feature ? x : h));

describe("riskFactors", () => {
  it("finds nothing for healthy values, and says every input was assessed", () => {
    expect(riskFactors(healthy)).toEqual({ found: [], notAssessed: [] });
  });
  it("flags each modifiable factor at its published threshold, not below it", () => {
    expect(ids(replace("current_smoker", c("current_smoker", 1)))).toEqual(["smoking"]);
    expect(ids(replace("fasting_blood_sugar", c("fasting_blood_sugar", 99)))).toEqual([]);
    expect(ids(replace("fasting_blood_sugar", c("fasting_blood_sugar", 126)))).toEqual(["glucose"]);
    expect(ids(replace("blood_pressure", c("blood_pressure", 139)))).toEqual([]);
    expect(ids(replace("blood_pressure", c("blood_pressure", 140)))).toEqual(["bp"]);
    expect(ids(replace("ldl", c("ldl", 160)))).toEqual(["ldl"]);
    expect(ids(replace("hdl", c("hdl", 39)))).toEqual(["hdl"]);
    expect(ids(replace("hdl", c("hdl", 40)))).toEqual([]);
    expect(ids(replace("triglycerides", c("triglycerides", 200)))).toEqual(["tg"]);
    expect(ids(replace("bmi", c("bmi", 27, "computed")))).toEqual(["bmi"]);
  });
  it("flags published borderline ranges as borderline, so no flags never reads as all normal (audit N07)", () => {
    const level = (cs: Contribution[]) => riskFactors(cs).found.map((r) => [r.id, r.level]);
    expect(level(replace("fasting_blood_sugar", c("fasting_blood_sugar", 125)))).toEqual([["glucose-borderline", "borderline"]]);
    expect(level(replace("fasting_blood_sugar", c("fasting_blood_sugar", 100)))).toEqual([["glucose-borderline", "borderline"]]);
    expect(level(replace("ldl", c("ldl", 130)))).toEqual([["ldl-borderline", "borderline"]]);
    expect(level(replace("ldl", c("ldl", 129)))).toEqual([]);
    expect(level(replace("triglycerides", c("triglycerides", 150)))).toEqual([["tg-borderline", "borderline"]]);
    // a high value is flagged once, as high, not also as borderline
    expect(level(replace("ldl", c("ldl", 170)))).toEqual([["ldl", "high"]]);
    expect(level(replace("fasting_blood_sugar", c("fasting_blood_sugar", 140)))).toEqual([["glucose", "high"]]);
  });
  it("uses the women's HDL criterion only for women", () => {
    const hdl45 = replace("hdl", c("hdl", 45));
    expect(ids([...hdl45, c("sex", 0)])).toEqual(["hdl-borderline"]);
    expect(ids([...hdl45, c("sex", 1)])).toEqual([]);
    expect(ids(hdl45)).toEqual([]); // sex unknown: no sex-specific claim
  });
  it("calls one raised reading raised, not a diagnosis, and says the systolic reading is assumed", () => {
    const bp = riskFactors(replace("blood_pressure", c("blood_pressure", 150))).found[0]!;
    expect(bp.title).toBe("Raised recorded blood pressure");
    expect(bp.info).toMatch(/not a diagnosis/);
    expect(bp.source).toMatch(/assumption/);
  });
  it("uses the recorded diagnosis as well as the measurement", () => {
    const r = riskFactors(replace("hypertension", c("hypertension", 1))).found;
    expect(r.map((x) => [x.id, x.evidence])).toEqual([["bp", "Hypertension: yes"]]);
  });
  it("never treats an unknown (imputed) value as healthy or as a risk factor", () => {
    const r = riskFactors(replace("ldl", c("ldl", 190, "imputed")));
    expect(r.found).toEqual([]);
    expect(r.notAssessed).toEqual([RULE_INPUTS.ldl]);
  });
  it("names no medicine and always points to a doctor or to habits", () => {
    const all = riskFactors([c("current_smoker", 1), c("diabetes", 1), c("hypertension", 1), c("dyslipidemia", 1),
      c("hdl", 30), c("triglycerides", 300), c("bmi", 32, "computed")]).found;
    expect(all).toHaveLength(7);
    for (const r of all) {
      expect(r.info).not.toMatch(/statin|aspirin|metformin|insulin|mg\b(?! ?\/)|tablet|dose/i);
      expect(r.info).toMatch(/doctor|activity|smoking/i);
    }
  });
});
