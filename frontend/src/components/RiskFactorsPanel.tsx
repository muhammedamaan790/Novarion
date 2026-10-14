// "Risk factors" case tab (D-034): the modifiable coronary risk factors in this case's recorded values, with general,
// well-established information. Educational, not advice: it reads the entered values (from the CAD explanation, which
// lists every measurement), never the prediction, and names no medicine, dose or test.
import { useQuery } from "@tanstack/react-query";
import type { DisplayAnalysis } from "../api/client";
import { explainQuery } from "../api/queries";
import { riskFactors } from "../cases/riskFactors";

const HABITS = [
  "not smoking", "regular physical activity", "a diet rich in vegetables, fruit and whole grains", "less salt",
  "limiting alcohol", "a healthy weight",
];

export function RiskFactorsPanel({ analysis }: { analysis: DisplayAnalysis }) {
  const stored = analysis.explanations.cad;
  const fetched = useQuery(explainQuery(analysis, "cad"));
  const explanation = stored ?? fetched.data?.explanation;
  if (!explanation) {
    return (
      <p className="text-sm text-slate-500" data-testid="risk-factors">
        {fetched.isError ? "The recorded values are unavailable." : "Loading the recorded values…"}
      </p>
    );
  }
  const { found, notAssessed } = riskFactors(explanation.contributions);

  return (
    <section className="space-y-4" data-testid="risk-factors" aria-label="Risk factors">
      <header>
        <h2 className="text-base font-bold text-slate-900">Modifiable risk factors in this patient's data</h2>
        <p className="mt-1 rounded-md bg-amber-50 p-2 text-sm font-semibold text-amber-900" role="note">
          Educational information, not medical advice. These come from the entered values and standard thresholds, not
          from the AI prediction. Any change in care should be discussed with a doctor.
        </p>
      </header>

      {found.length === 0 ? (
        <p className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900" data-testid="risk-none">
          None of the modifiable risk factors checked here is present in the recorded values
          {notAssessed.length > 0 ? " that could be assessed" : ""}.
        </p>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {found.map((r) => (
            <li key={r.id} className="rounded-lg border border-slate-200 bg-white p-3" data-testid={`risk-${r.id}`}>
              <p className="font-bold text-slate-900">{r.title}</p>
              <p className="text-xs font-semibold text-slate-600">{r.evidence}</p>
              <p className="mt-1.5 text-sm text-slate-800">{r.info}</p>
              <p className="mt-1.5 text-[11px] text-slate-500">Threshold: {r.source}</p>
            </li>
          ))}
        </ul>
      )}

      {notAssessed.length > 0 && (
        <p className="text-sm text-slate-700" data-testid="risk-not-assessed">
          Not assessed (value unknown): {notAssessed.join(", ")}.
        </p>
      )}

      <div className="rounded-lg bg-slate-50 p-3 text-sm text-slate-800">
        <p className="font-semibold">Heart-healthy habits for everyone (WHO)</p>
        <p className="mt-1">{HABITS.join(" · ")}.</p>
      </div>
      <p className="text-xs text-slate-500">
        Checked: smoking, diabetes and fasting blood sugar, blood pressure, LDL, HDL, triglycerides and BMI. Age, sex and
        family history also affect coronary risk but cannot be changed.
      </p>
    </section>
  );
}
