// Screen "Model Center" (plan §12B): production status, the registry, gate reports, the replay study and the audit
// log. Read-only everywhere: promotion and rollback are CLI-only with human approval. Wording rule: "designed for
// continual supervised updating as verified cases accumulate"; never "the AI keeps getting smarter".
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, TARGET_IDS, api, type Meta, type Schemas } from "../../api/client";
import { listCases } from "../../cases/caseStore";
import { SHORT } from "../wording";
import { LineChart } from "../evidence/LineChart";

const C = { primary: "#2a78d6" };
const STATUS_STYLE: Record<string, string> = {
  production: "bg-emerald-100 text-emerald-800", candidate: "bg-sky-100 text-sky-900", rejected: "bg-red-100 text-red-800",
  retired: "bg-slate-100 text-slate-600", replay: "bg-violet-100 text-violet-800",
};
const GATE_STYLE: Record<string, string> = {
  PASS: "text-emerald-700", FAIL: "text-red-700", INSUFFICIENT_EVIDENCE: "text-amber-800",
};
const RULE_TEXT: Record<string, string> = {
  delta_auc_ci_low_above_margin: "ΔAUC 95% CI lower bound > −0.05",
  delta_brier_point_ok: "ΔBrier ≤ +0.01",
  delta_brier_ci_high_ok: "ΔBrier 95% CI upper bound ≤ +0.03",
  cal_slope_ci_overlaps: "calibration-slope CI overlaps [0.8, 1.2]",
  mean_calibration_diff_ok: "|observed − mean predicted| ≤ 0.10",
  improved: "improvement (ΔAUC ≥ +0.01 or ΔBrier ≤ −0.005)",
};
const f3 = (v: number | null | undefined) => (v == null ? "—" : v.toFixed(3));
const ci = (v: number[] | null | undefined) => (v ? `[${v[0]!.toFixed(3)}, ${v[1]!.toFixed(3)}]` : "—");
const sizeToX = (n: number) => (n - 100) / 200; // the shared chart has a unit domain
const xToSize = (x: number) => String(Math.round(x * 200 + 100));
const aucToY = (auc: number) => (auc - 0.5) / 0.5; // y axis spans AUC 0.50 (chance, the baseline) to 1.00
const yToAuc = (y: number) => (0.5 + y * 0.5).toFixed(2);

function GateReport({ version }: { version: string }) {
  const report = useQuery({ queryKey: ["model-report", version], queryFn: async () => (await api.modelReport(version)).data });
  if (report.isPending) return <p className="text-xs text-slate-500">Loading gate report…</p>;
  if (report.isError || !report.data) return <p className="text-xs text-red-700">Gate report unavailable.</p>;
  const r = report.data;
  return (
    <div className="mt-2 space-y-2" data-testid="gate-report">
      <p className="text-xs text-slate-700">
        Candidate v{r.version} vs production v{r.champion_version} on the same forward-holdout cases (paired) ·{" "}
        <b className={GATE_STYLE[r.gate_status]}>{r.gate_status.replaceAll("_", " ")}</b> ·{" "}
        <span className="text-slate-500">{r.evidence_label}</span>
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-[11px] tabular-nums">
          <thead className="text-left text-slate-500">
            <tr><th className="pr-2">Target</th><th className="pr-2">AUC prod → chall.</th><th className="pr-2">ΔAUC 95% CI</th>
              <th className="pr-2">Brier prod → chall.</th><th className="pr-2">ΔBrier 95% CI</th><th className="pr-2">Slope 95% CI</th>
              <th>Rules</th></tr>
          </thead>
          <tbody>
            {TARGET_IDS.map((t) => {
              const g = r.targets[t]!;
              const failed = Object.entries(g.rules).filter(([, ok]) => !ok).map(([k]) => RULE_TEXT[k] ?? k);
              return (
                <tr key={t} className="border-t border-slate-100 align-top">
                  <td className="pr-2 font-semibold">{SHORT[t]}</td>
                  {g.evaluable ? (
                    <>
                      <td className="pr-2">{f3(g.auc_champion)} → {f3(g.auc_challenger)}</td>
                      <td className="pr-2">{ci(g.delta_auc_ci95)}</td>
                      <td className="pr-2">{f3(g.brier_champion)} → {f3(g.brier_challenger)}</td>
                      <td className="pr-2">{ci(g.delta_brier_ci95)}</td>
                      <td className="pr-2">{ci(g.cal_slope_ci95)}</td>
                      <td>{failed.length ? <span className="text-red-700">✗ {failed.join("; ")}</span> : <span className="text-emerald-700">✓ all</span>}</td>
                    </>
                  ) : <td colSpan={6} className="text-amber-800">insufficient evidence (too few holdout positives/negatives)</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Local mode only, gate PASS only: the in-app wrapper around `make promote` (plan §12B, Tier 3). */
function PromoteForm({ version, onDone }: { version: string; onDone: () => void }) {
  const [approver, setApprover] = useState("");
  const [token, setToken] = useState("");
  const [state, setState] = useState<{ busy: boolean; message: string | null; error: boolean }>(
    { busy: false, message: null, error: false });
  return (
    <form className="mt-2 flex flex-wrap items-end gap-2 rounded border border-amber-300 bg-amber-50 p-2 text-[11px]"
          data-testid="promote-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setState({ busy: true, message: null, error: false });
            try {
              const r = await api.promote(version, approver.trim(), token);
              setState({ busy: false, message: r.data.message, error: false });
              onDone();
            } catch (err) {
              const message = err instanceof ApiError ? err.message : String(err);
              setState({ busy: false, message, error: true });
            }
          }}>
      <p className="w-full text-amber-900">
        Human approval: refits the gated configuration on all verified cases and makes it production. Same as{" "}
        <code>make promote VERSION={version}</code>; logged with your name.
      </p>
      <label>Approver{" "}
        <input value={approver} onChange={(e) => setApprover(e.target.value)} required minLength={2} maxLength={80}
               className="rounded border border-slate-300 px-1" />
      </label>
      <label>Admin token{" "}
        <input type="password" value={token} onChange={(e) => setToken(e.target.value)} required autoComplete="off"
               className="rounded border border-slate-300 px-1" />
      </label>
      <button type="submit" disabled={state.busy} className="rounded bg-amber-700 px-2 py-1 font-semibold text-white disabled:opacity-50">
        {state.busy ? "Promoting…" : `Promote v${version}`}
      </button>
      {state.message && <p role="status" className={`w-full ${state.error ? "text-red-700" : "text-emerald-800"}`}>{state.message}</p>}
    </form>
  );
}

function ReplayStudy({ replay }: { replay: Schemas["ReplayResponse"] }) {
  const sizes = replay.training_sizes;
  const gates = Object.entries(replay.gate_frequencies);
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-3" data-testid="replay-study">
      <h2 className="text-sm font-bold text-slate-900">{replay.title}</h2>
      <p className="mt-1 text-xs text-slate-600">
        Research demonstration on the same 303 public patients, replayed through the same lifecycle code (freeze →
        paired gate → promote/reject). {replay.seeds} pre-registered random arrival orders; initial cohort {sizes[0]},
        then batches of {replay.holdout_batch_size}. Each point = the model trained on that many patients, scored on the{" "}
        <i>next</i> {replay.holdout_batch_size} arrivals (never on its own training rows). Replay search space:{" "}
        {replay.families.join(" + ")} (a documented compute reduction). Replay models never become production.
      </p>
      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {TARGET_IDS.map((t) => {
          const pts = replay.learning_curve[t]!;
          return (
            <LineChart key={t} title={`Learning curve · ${SHORT[t]}`}
                       caption={`AUC on the next ${replay.holdout_batch_size} arrivals · mean of ${replay.seeds} orders · band = min–max`}
                       xLabel="Training size (patients)" yLabel="Forward-holdout AUC (0.5 = chance)" formatX={xToSize}
                       formatY={yToAuc}
                       series={[{ id: t, label: "mean AUC", color: C.primary, x: pts.map((p) => sizeToX(p.training_size)),
                                  y: pts.map((p) => aucToY(p.auc_mean)), lo: pts.map((p) => aucToY(p.auc_min)),
                                  hi: pts.map((p) => aucToY(p.auc_max)) }]} />
          );
        })}
      </div>
      <table className="mt-2 text-xs tabular-nums">
        <thead className="text-left text-slate-500"><tr><th className="pr-3">Gate</th><th className="pr-3">PASS</th>
          <th className="pr-3">FAIL</th><th>Insufficient evidence</th></tr></thead>
        <tbody>
          {gates.map(([g, f]) => (
            <tr key={g} className="border-t border-slate-100">
              <td className="pr-3">{g}</td><td className="pr-3">{f.PASS}</td><td className="pr-3">{f.FAIL}</td>
              <td>{f.INSUFFICIENT_EVIDENCE}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1 text-[11px] text-slate-500">
        A FAIL means the current model stays: with holdouts of {replay.holdout_batch_size} the confidence intervals are wide,
        so the pre-registered gate is conservative by design. The curve shows whether more verified cases are likely to help
        each vessel model; it is not temporal validation and makes no claim that the model improves over time.
      </p>
    </section>
  );
}

export function ModelCenterPage() {
  const models = useQuery({ queryKey: ["models"], queryFn: async () => (await api.models()).data });
  const meta = useQuery<{ data: Meta }>({ queryKey: ["meta"], queryFn: api.meta, staleTime: Infinity });
  const canPromote = !!meta.data?.data.promote_available;
  const replay = useQuery({ queryKey: ["replay"], queryFn: async () => (await api.replay()).data, retry: false });
  const cases = useQuery({ queryKey: ["cases"], queryFn: listCases });
  const [openReport, setOpenReport] = useState<string | null>(null);
  const localPending = cases.data?.filter((c) => c.source !== "dataset" && c.outcomes?.length).length ?? 0;
  const m = models.data;
  return (
    <div className="mx-auto max-w-6xl space-y-3 p-4" data-testid="model-center">
      <section className="rounded-lg border border-slate-200 bg-white p-3">
        <h1 className="text-base font-bold text-slate-900">Model Center</h1>
        <p className="text-xs text-slate-600">
          Designed for continual supervised updating as verified cases accumulate: predictions always come from the current
          production model, and a new version is only ever promoted by a person, after a pre-registered validation gate.
          The model never learns from its own predictions.
        </p>
        {models.isError && <p className="mt-2 text-xs text-red-700">Registry unavailable.</p>}
        {m && (
          <div className="mt-2 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
            <div className="rounded bg-emerald-50 p-2">
              <div className="text-slate-500">Production</div>
              <div className="font-bold text-emerald-800" data-testid="mc-production">v{m.production_version} ● READY</div>
              {m.deployed_version !== m.production_version && (
                <div className="text-amber-800">deployed bundle v{m.deployed_version}: restart pending</div>
              )}
            </div>
            <div className="rounded bg-slate-50 p-2">
              <div className="text-slate-500">Pending outcomes (this browser)</div>
              <div className="font-bold tabular-nums">{localPending}</div>
            </div>
            <div className="rounded bg-slate-50 p-2">
              <div className="text-slate-500">Steward-verified new cases</div>
              <div className="font-bold tabular-nums">{m.verified_new_cases}</div>
            </div>
            <div className="rounded bg-slate-50 p-2">
              <div className="text-slate-500">Training-eligible (verified + timing verified)</div>
              <div className="font-bold tabular-nums">{m.eligible_cases}</div>
            </div>
          </div>
        )}
      </section>

      {m && (
        <section className="rounded-lg border border-slate-200 bg-white p-3">
          <h2 className="text-sm font-bold text-slate-900">Model registry</h2>
          <table className="mt-1 w-full text-xs tabular-nums" data-testid="mc-registry">
            <thead className="text-left text-slate-500">
              <tr><th className="pr-2">Version</th><th className="pr-2">Status</th><th className="pr-2">Gate</th>
                <th className="pr-2">Training cases</th><th className="pr-2">Created (UTC)</th><th>Manifest</th></tr>
            </thead>
            <tbody>
              {[...m.models].reverse().map((e) => (
                <tr key={e.version} className="border-t border-slate-100">
                  <td className="pr-2 font-semibold">v{e.version}</td>
                  <td className="pr-2"><span className={`rounded px-1.5 font-semibold ${STATUS_STYLE[e.status] ?? ""}`}>{e.status}</span></td>
                  <td className="pr-2">
                    {e.gate_status ? (
                      <button type="button" className={`underline ${GATE_STYLE[e.gate_status]}`}
                              onClick={() => setOpenReport(openReport === e.version ? null : e.version)}>
                        {e.gate_status.replaceAll("_", " ")}
                      </button>
                    ) : <span className="text-slate-400">—</span>}
                  </td>
                  <td className="pr-2">{e.training_cases}</td>
                  <td className="pr-2">{e.created_at.replace("T", " ").replace("Z", "")}</td>
                  <td><code className="text-[10px]">{e.artifact_manifest_sha256.slice(0, 12)}…</code></td>
                </tr>
              ))}
            </tbody>
          </table>
          {openReport && <GateReport version={openReport} />}
          {canPromote && m.models.filter((e) => e.status === "candidate" && e.gate_status === "PASS").map((e) => (
            <PromoteForm key={e.version} version={e.version} onDone={() => void models.refetch()} />
          ))}
          <p className="mt-2 text-[11px] text-slate-500">
            v1.0.0 is the frozen hackathon model; its nested-CV evaluation (Model Evidence) is the official result and is
            never overwritten. v1.0.1 serves the identical models and adds stability intervals for dataset patients. Bundles referenced here are never deleted, so any version can be restored.
          </p>
        </section>
      )}

      <section className="rounded-lg border border-slate-200 bg-white p-3 text-xs text-slate-700">
        <h2 className="text-sm font-bold text-slate-900">How a verified case can reach a model update</h2>
        <ol className="mt-1 list-decimal space-y-0.5 pl-5">
          <li>A reviewer records the angiographic outcome on a saved case: stored as <b>pending</b>, bound to that exact input.</li>
          <li><b>Export learning package</b> (My cases): allowlisted fields only, with no notes, names, dates or identifiers.</li>
          <li><code>make verify-outcomes</code>: the model steward checks the label definition, provenance and that every input
            predates the angiogram → verified / rejected / conflicted.</li>
          <li><code>make candidate</code>: the newest verified cases become an untouched forward holdout; a challenger is trained
            on the rest, frozen, and scored once against production on that holdout → pre-registered paired gate.</li>
          <li>A person reads the gate report and runs <code>make promote</code> (gate PASS only) or <code>make reject</code>;
            <code> make rollback</code> restores any earlier version. Every step is written to a hash-chained audit log.</li>
        </ol>
      </section>

      {replay.data && <ReplayStudy replay={replay.data} />}
      {replay.isError && (
        <p className="rounded border border-slate-200 bg-white p-3 text-xs text-slate-500">The replay study has not been run yet.</p>
      )}

      {m && (
        <section className="rounded-lg border border-slate-200 bg-white p-3">
          <h2 className="text-sm font-bold text-slate-900">
            Lifecycle audit log{" "}
            <span className={`ml-1 text-xs font-semibold ${m.lifecycle_log_status === "broken" ? "text-red-700" : "text-emerald-700"}`}
                  data-testid="mc-log-status">
              {m.lifecycle_log_status === "intact" ? "hash chain intact" : m.lifecycle_log_status === "empty"
                ? "no events yet" : "HASH CHAIN BROKEN"}
            </span>
          </h2>
          {m.lifecycle_events.length > 0 ? (
            <ul className="mt-1 space-y-0.5 text-xs text-slate-700">
              {m.lifecycle_events.map((e) => (
                <li key={e.seq} className="tabular-nums">
                  <span className="text-slate-500">#{e.seq} {e.timestamp.replace("T", " ").replace("Z", "")}</span> · {e.summary}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-xs text-slate-500">
              No verification, candidate, promotion or rollback has happened: production is the frozen v1.0 model.
            </p>
          )}
        </section>
      )}
    </div>
  );
}
