# NOVARION error analysis

Scope: **pooled OOF (prespecified repeat)** — every patient predicted by a model that never saw them. Representative cases are selected by the stated rule (lowest patient id meeting it), not by browsing.

## Errors by confidence region

| Target | Errors / n | FP | FN | Errors shown with HIGH model confidence | Errors shown with LOW |
|---|---|---|---|---|---|
| CAD | 42 / 303 | 12 | 30 | 8 | 34 |
| LAD | 76 / 303 | 35 | 41 | 0 | 76 |
| LCX | 101 / 303 | 73 | 28 | 0 | 101 |
| RCA | 95 / 303 | 55 | 40 | 0 | 95 |

## Misclassified vs correctly classified (descriptive means / proportions)

| Measurement | CAD correct | CAD wrong | LAD correct | LAD wrong | LCX correct | LCX wrong | RCA correct | RCA wrong |
|---|---|---|---|---|---|---|---|---|
| Age (y) | 59.0 | 58.0 | 59.0 | 58.6 | 58.2 | 60.3 | 58.3 | 60.3 |
| Typical chest pain | 59% | 26% | 53% | 58% | 46% | 71% | 46% | 72% |
| Region RWMA ≠ 0 | 30% | 17% | 33% | 16% | 24% | 38% | 23% | 41% |
| EF (%) | 46.9 | 49.3 | 46.6 | 49.1 | 47.5 | 46.6 | 47.7 | 46.2 |
| Diabetes | 31% | 19% | 27% | 37% | 29% | 31% | 29% | 32% |
| Hypertension | 62% | 43% | 58% | 63% | 57% | 63% | 58% | 62% |
| Male | 57% | 64% | 59% | 55% | 57% | 59% | 54% | 66% |

## Representative cases (rule-selected)

### ZAS-0002 — Correct, HIGH confidence (CAD): lowest id with high_positive and CAD label = 1

| Target | Probability | Predicted | Model confidence | Dataset label |
|---|---|---|---|---|
| CAD | 1.00 | positive | HIGH | positive |
| LAD | 0.99 | positive | LOW | positive |
| LCX | 0.64 | positive | LOW | positive |
| RCA | 0.38 | negative | LOW | negative |

Atypical profile: no (distance percentile 80.6). Top CAD model contributions: Region with RWMA = 4 (up, strong); Typical chest pain = Yes (up, strong); T inversion = Yes (up, strong); Triglycerides = 309 mg/dL (up, strong).

### ZAS-0094 — Error in the high-positive region (CAD): lowest id with high_positive and CAD label = 0

| Target | Probability | Predicted | Model confidence | Dataset label |
|---|---|---|---|---|
| CAD | 0.98 | positive | LOW | negative |
| LAD | 0.70 | positive | LOW | positive |
| LCX | 0.69 | positive | LOW | negative |
| RCA | 0.55 | positive | LOW | negative |

**Note:** this is the D-001 record (source row 93): LAD = Stenotic but Cath = Normal in the published labels, i.e. the CAD 'error' coincides with the one label discordance in the dataset.

The atypical-profile flag forces LOW model confidence even inside a high-confidence region.

Atypical profile: yes (distance percentile 46.5). Top CAD model contributions: Typical chest pain = Yes (up, strong); Region with RWMA = 0 (down, strong); Atypical chest pain = No (up, strong); Hypertension = Yes (up, strong).

### ZAS-0288 — Near the operating threshold (LAD): smallest |p − t_op|

| Target | Probability | Predicted | Model confidence | Dataset label |
|---|---|---|---|---|
| CAD | 0.31 | negative | LOW | negative |
| LAD | 0.55 | positive | LOW | negative |
| LCX | 0.15 | negative | LOW | negative |
| RCA | 0.13 | negative | LOW | negative |

Atypical profile: no (distance percentile 45.5). Top LAD model contributions: Typical chest pain = No (down, strong); Creatinine = 1.40 mg/dL (up, strong); Region with RWMA = 0 (down, strong); Ejection fraction (TTE) = 45% (up, strong).

### ZAS-0004 — Atypical profile: lowest id with the atypical flag

| Target | Probability | Predicted | Model confidence | Dataset label |
|---|---|---|---|---|
| CAD | 0.18 | negative | LOW | negative |
| LAD | 0.37 | negative | LOW | negative |
| LCX | 0.18 | negative | LOW | negative |
| RCA | 0.28 | negative | LOW | negative |

The atypical-profile flag forces LOW model confidence even inside a high-confidence region.

Atypical profile: yes (distance percentile 98.8). Top CAD model contributions: Typical chest pain = No (down, strong); Non-anginal chest pain = Yes (down, strong); Age = 66 years (up, strong); Triglycerides = 63 mg/dL (down, strong).

