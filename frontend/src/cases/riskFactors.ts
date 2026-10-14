// Modifiable coronary risk factors present in a case's recorded values (D-034). Educational only: each rule is a
// standard, published threshold applied to the entered values, never the model's prediction, and the text names no
// medicine, dose or test. Missing or unknown values are reported as not assessable, never as "fine". Values in a
// published borderline range are flagged as borderline (audit N07), so "no flags" never reads as "all normal".
import type { Contribution } from "../api/client";

export interface RiskFactor {
  id: string;
  /** "high": at or beyond the selected threshold (or a recorded diagnosis); "borderline": a published borderline range */
  level: "high" | "borderline";
  title: string;
  /** the recorded value(s) that triggered it */
  evidence: string;
  /** general, well-established information; ends by pointing to a clinician */
  info: string;
  source: string;
}

type Values = Map<string, Contribution>;
const known = (c: Contribution | undefined) => !!c && c.value_status !== "imputed"; // unknown inputs are imputed
const num = (c: Contribution | undefined) => (known(c) && typeof c!.value === "number" ? c!.value : null);
const yes = (c: Contribution | undefined) => known(c) && (c!.value === 1 || c!.value === "1" || c!.value === "Y");

const RULES: ((v: Values) => RiskFactor | null)[] = [
  (v) => yes(v.get("current_smoker")) ? {
    id: "smoking", level: "high", title: "Current smoker", evidence: "Current smoker: yes",
    info: "Smoking is one of the strongest modifiable risk factors for coronary artery disease, and stopping lowers the risk over time. A doctor can help with stopping.",
    source: "WHO, cardiovascular diseases fact sheet",
  } : null,
  (v) => {
    const fbs = num(v.get("fasting_blood_sugar"));
    const dm = yes(v.get("diabetes"));
    if (!dm && (fbs === null || fbs < 126)) return null;
    return {
      id: "glucose", level: "high", title: dm ? "Diabetes" : "High fasting blood sugar",
      evidence: [dm ? "Diabetes: yes" : null, fbs !== null && fbs >= 126 ? `fasting blood sugar ${fbs} mg/dL (≥ 126)` : null]
        .filter(Boolean).join(" · "),
      info: "Diabetes and raised blood sugar increase coronary risk; keeping blood sugar in a healthy range is part of prevention. A doctor can advise on control.",
      source: "American Diabetes Association diagnostic threshold (fasting glucose ≥ 126 mg/dL)",
    };
  },
  (v) => {
    const bp = num(v.get("blood_pressure"));
    const htn = yes(v.get("hypertension"));
    if (!htn && (bp === null || bp < 140)) return null;
    return {
      id: "bp", level: "high", title: htn ? "Hypertension (recorded)" : "Raised recorded blood pressure",
      evidence: [htn ? "Hypertension: yes" : null, bp !== null && bp >= 140 ? `recorded blood pressure ${bp} mmHg (≥ 140)` : null]
        .filter(Boolean).join(" · "),
      info: "High blood pressure strains the heart and arteries. One raised reading is not a diagnosis: blood pressure "
        + "is confirmed with repeated measurements. Less salt, regular activity and a healthy weight help; a doctor can advise.",
      source: "WHO hypertension threshold (≥ 140 mmHg systolic). The dataset records one blood-pressure value; that it is "
        + "systolic is this project's assumption, not stated by the source.",
    };
  },
  (v) => {
    const ldl = num(v.get("ldl"));
    const dl = yes(v.get("dyslipidemia"));
    const highLdl = ldl !== null && ldl >= 160;
    if (!dl && !highLdl) return null;
    return {
      id: "ldl", level: "high", title: highLdl ? "High LDL cholesterol" : "Dyslipidemia",
      evidence: [dl ? "Dyslipidemia: yes" : null, highLdl ? `LDL ${ldl} mg/dL (≥ 160)` : null].filter(Boolean).join(" · "),
      info: "High LDL (\"bad\") cholesterol builds up in artery walls. Diet and physical activity affect it; a doctor can advise on cholesterol management.",
      source: "NCEP ATP III (LDL ≥ 160 mg/dL: high)",
    };
  },
  (v) => {
    const hdl = num(v.get("hdl"));
    return hdl !== null && hdl < 40 ? {
      id: "hdl", level: "high", title: "Low HDL cholesterol", evidence: `HDL ${hdl} mg/dL (< 40)`,
      info: "Low HDL (\"good\") cholesterol is linked to higher coronary risk; regular physical activity and not smoking can raise it.",
      source: "NCEP ATP III (HDL < 40 mg/dL: low)",
    } : null;
  },
  (v) => {
    const tg = num(v.get("triglycerides"));
    return tg !== null && tg >= 200 ? {
      id: "tg", level: "high", title: "High triglycerides", evidence: `triglycerides ${tg} mg/dL (≥ 200)`,
      info: "High triglycerides are linked to coronary risk; diet, alcohol, weight and activity all affect them. A doctor can advise.",
      source: "NCEP ATP III (triglycerides ≥ 200 mg/dL: high)",
    } : null;
  },
  (v) => {
    const bmi = num(v.get("bmi"));
    if (bmi === null || bmi < 25) return null;
    return {
      id: "bmi", level: "high", title: bmi >= 30 ? "Obesity" : "Overweight", evidence: `BMI ${bmi.toFixed(1)} kg/m² (${bmi >= 30 ? "≥ 30" : "25–29.9"})`,
      info: "Excess weight raises blood pressure, cholesterol and blood sugar. Regular activity and a balanced diet help; a doctor can advise.",
      source: "WHO BMI classification",
    };
  },
  // ---- published borderline ranges (only when the high rule above did not fire for the same measure)
  (v) => {
    const fbs = num(v.get("fasting_blood_sugar"));
    return !yes(v.get("diabetes")) && fbs !== null && fbs >= 100 && fbs < 126 ? {
      id: "glucose-borderline", level: "borderline", title: "Fasting blood sugar in the prediabetes range",
      evidence: `fasting blood sugar ${fbs} mg/dL (100–125)`,
      info: "Fasting blood sugar between 100 and 125 mg/dL is above the normal range and is linked to a higher risk of "
        + "diabetes and heart disease. Activity, diet and weight affect it; a doctor can advise.",
      source: "NIDDK (fasting glucose 100–125 mg/dL: prediabetes)",
    } : null;
  },
  (v) => {
    const ldl = num(v.get("ldl"));
    return !yes(v.get("dyslipidemia")) && ldl !== null && ldl >= 130 && ldl < 160 ? {
      id: "ldl-borderline", level: "borderline", title: "Borderline-high LDL cholesterol", evidence: `LDL ${ldl} mg/dL (130–159)`,
      info: "LDL between 130 and 159 mg/dL is above the optimal range. Diet and physical activity affect it; a doctor can advise.",
      source: "NCEP ATP III (LDL 130–159 mg/dL: borderline high)",
    } : null;
  },
  (v) => {
    const tg = num(v.get("triglycerides"));
    return tg !== null && tg >= 150 && tg < 200 ? {
      id: "tg-borderline", level: "borderline", title: "Borderline-high triglycerides", evidence: `triglycerides ${tg} mg/dL (150–199)`,
      info: "Triglycerides between 150 and 199 mg/dL are above normal; diet, alcohol, weight and activity all affect them. A doctor can advise.",
      source: "NCEP ATP III (triglycerides 150–199 mg/dL: borderline high)",
    } : null;
  },
  (v) => {
    const hdl = num(v.get("hdl"));
    const female = known(v.get("sex")) && (v.get("sex")!.value === 0 || v.get("sex")!.value === "0");
    return female && hdl !== null && hdl >= 40 && hdl < 50 ? {
      id: "hdl-borderline", level: "borderline", title: "HDL cholesterol below 50 mg/dL (women)", evidence: `HDL ${hdl} mg/dL (< 50)`,
      info: "For women, HDL (\"good\") cholesterol below 50 mg/dL is counted as a risk marker; regular activity and not smoking can raise it.",
      source: "NCEP ATP III metabolic-syndrome criterion (HDL < 50 mg/dL in women)",
    } : null;
  },
];

/** The values the rules read; any of them missing or unknown is listed, so "none found" is never overstated. */
export const RULE_INPUTS: Record<string, string> = {
  current_smoker: "Current smoker", diabetes: "Diabetes", fasting_blood_sugar: "Fasting blood sugar",
  hypertension: "Hypertension", blood_pressure: "Blood pressure", dyslipidemia: "Dyslipidemia", ldl: "LDL",
  hdl: "HDL", triglycerides: "Triglycerides", bmi: "BMI",
};

export function riskFactors(contributions: Contribution[]): { found: RiskFactor[]; notAssessed: string[] } {
  const v: Values = new Map(contributions.map((c) => [c.feature, c]));
  return {
    found: RULES.map((rule) => rule(v)).filter((r): r is RiskFactor => r !== null),
    notAssessed: Object.entries(RULE_INPUTS).filter(([id]) => !known(v.get(id))).map(([, label]) => label),
  };
}
