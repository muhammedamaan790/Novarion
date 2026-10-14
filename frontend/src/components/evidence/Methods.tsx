// Methods and limitations (D-035): what the evidence on this page rests on, from the model card, config/targets.yaml and
// the TRIPOD-AI checklist (docs/). Written for model v1.0.2; a different served model is flagged, never silently relabelled.
import type { ReactNode } from "react";
import type { EvidenceIdentity } from "./boundEvidence";
import { Card } from "./kit";

const DOCUMENTED_VERSION = "1.0.2";

function Item({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="border-t border-slate-100 py-2.5 first:border-t-0 first:pt-0 md:grid md:grid-cols-[12rem_1fr] md:gap-4">
      <dt className="text-sm font-semibold text-slate-900">{term}</dt>
      <dd className="mt-0.5 text-sm text-slate-700 md:mt-0">{children}</dd>
    </div>
  );
}

export function Methods({ modelVersion, identity }: { modelVersion: string; identity: EvidenceIdentity | undefined }) {
  return (
    <div className="space-y-4" data-testid="evidence-methods">
      {modelVersion !== DOCUMENTED_VERSION && (
        <p role="note" className="rounded bg-amber-50 p-2 text-sm text-amber-900">
          These methods are documented for model v{DOCUMENTED_VERSION}; the evaluation shown is for v{modelVersion}.
        </p>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Intended use and targets">
          <dl>
            <Item term="Intended use">
              Educational and research decision support: estimating the probability of the dataset&apos;s CAD and per-vessel
              stenosis labels from routine clinical features, for review by clinicians or researchers.
            </Item>
            <Item term="Out of scope">
              Diagnosis; lesion location or severity; test or treatment recommendations; causal reading of contributions;
              event or mortality risk; patient self-assessment; any other population without external validation.
            </Item>
            <Item term="Targets">
              Overall CAD: the dataset label &quot;Cath = CAD&quot; (≥ 50% stenosis in at least one major vessel by angiography).
              LAD, LCX, RCA: ≥ 50% stenosis of that artery by angiography. Four independent binary classifiers.
            </Item>
          </dl>
        </Card>
        <Card title="Data">
          <dl>
            <Item term="Provenance">
              Extension of Z-Alizadeh Sani (UCI #411, CC BY 4.0): 303 patients from one centre, 55 predictors (demographic,
              history, examination, ECG, laboratory, echocardiography). Checksum-pinned; the public record gives no dates.
            </Item>
            <Item term="Inclusion">
              As published with the dataset: patients referred for coronary angiography. No further exclusions.
            </Item>
            <Item term="Reference standard">
              The dataset&apos;s angiographic labels. Assessor blinding and the timing of predictors relative to angiography
              are not reported by the source (a reporting gap, not evidence of leakage).
            </Item>
            <Item term="Missing values">
              None in the source. For new cases an explicit UNKNOWN is imputed from the training fold only and forces the
              analysis outside the qualified range.
            </Item>
          </dl>
        </Card>
        <Card title="Model development and leakage prevention">
          <dl>
            <Item term="Preprocessing">
              Feature registry with units, valid ranges and encodings; label columns and their derivatives are never inputs
              (lineage-aware denylist, tested).
            </Item>
            <Item term="Feature sets">
              Pre-registered grid of 92 configurations: four families (logistic regression, EBM, XGBoost, CatBoost), class
              weighting, and two feature sets (full, or redundancy-reduced: weight, height and obesity dropped as BMI carries them).
            </Item>
            <Item term="Calibration and thresholds">
              Platt scaling on cross-fitted out-of-fold logits; the operating threshold t_op is Youden&apos;s J on
              training-side probabilities. Both are chosen on training data only.
            </Item>
          </dl>
        </Card>
        <Card title="Validation design">
          <dl>
            <Item term="Nested cross-validation">
              Outer stratified 5-fold × 5 repeats (25 outer folds) for evaluation; inner 5-fold for model selection with the
              1-SE rule. Tuning, calibration and thresholds never see the outer test fold.
            </Item>
            <Item term="Two reporting scopes">
              Outer-fold mean ± SD across the 25 folds (Performance, Summary): the SD is fold-to-fold spread, not a
              confidence interval. Pooled out-of-fold predictions of the prespecified repeat (Curves, Confidence tiers,
              guideline comparison) with patient-level bootstrap 95% CIs.
            </Item>
            <Item term="Internal vs external">
              Internal validation only. There is no external or temporal validation; it is the necessary next step before
              any clinical use.
            </Item>
          </dl>
        </Card>
        <Card title="Metrics and confidence">
          <dl>
            <Item term="Discrimination">ROC-AUC and PR-AUC (threshold-free ranking).</Item>
            <Item term="Calibration">
              Reliability bins, calibration slope and intercept, calibration-in-the-large, ECE and the Brier score.
            </Item>
            <Item term="At a threshold">
              Sensitivity, specificity, PPV and NPV at t_op. PPV and NPV depend on prevalence (CAD 71% here) and do not transfer.
            </Item>
            <Item term="Confidence tiers">
              High support only inside a score region whose Wilson 95% lower bound met the pre-registered PPV ≥ 90% /
              NPV ≥ 95% (n ≥ 15), and only if no display gate applies (input quality, atypical profile, stability).
              Engineering criteria fixed before results, not clinical standards.
            </Item>
          </dl>
        </Card>
        <Card title="Limitations">
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-slate-700">
            <li>One public cohort of 303 patients with high CAD prevalence (71%), referred for angiography.</li>
            <li>No external or temporal validation; results may not generalise to other centres or populations.</li>
            <li>Subgroups are small (for example 58 patients under 50), so intervals are wide; no fairness claim is made.</li>
            <li>No vessel target (LAD, LCX, RCA) has a qualified high-support region.</li>
            <li>One discordant label record (LAD stenotic with Cath = Normal) is kept as published.</li>
            <li>Contributions are associations learned by the model, not causes.</li>
          </ul>
        </Card>
      </div>
      <Card title="Not available in this evaluation" testId="evidence-unavailable"
            subtitle="shown as unavailable on the page rather than estimated">
        <ul className="grid list-disc gap-x-8 gap-y-1 pl-5 text-sm text-slate-700 md:grid-cols-2">
          <li>External or temporal validation results.</li>
          <li>A pooled ROC operating point (only outer-fold sensitivity/specificity at t_op).</li>
          <li>Average precision on pooled predictions (only the outer-fold PR-AUC).</li>
          <li>Confidence intervals for single-model AUCs in the guideline comparison (only the paired ΔAUC has one).</li>
          <li>Confidence intervals for subgroup sensitivity and specificity.</li>
          <li>A comparison with the ESC 2024 risk-factor-weighted clinical-likelihood model.</li>
          <li>Statistical tests of equivalence or superiority between model types.</li>
          <li>NPV of a qualified-negative tier: no patient qualified, so it is not estimable.</li>
        </ul>
      </Card>
      <p className="text-xs text-slate-600" data-testid="evidence-version">
        Evaluation for model v{modelVersion}
        {identity && <> · evidence files bound to v{identity.model_version}, artifact manifest {identity.artifact_manifest_sha256.slice(0, 16)}…</>}
        {" "}· reproducible with <code>make reproduce</code> · model card: docs/model_card.md · reporting checklist: docs/tripod_ai.md
      </p>
    </div>
  );
}
