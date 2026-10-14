// The Model Center shares the Model Evidence chart engine (Recharts, D-037), so it too loads only when opened and the
// app shell stays small for every other page.
import { Suspense, lazy } from "react";

const ModelCenterPageImpl = lazy(() => import("./ModelCenterPage").then((m) => ({ default: m.ModelCenterPage })));

export function ModelCenterPage() {
  return (
    <Suspense fallback={<p className="p-6 text-sm text-slate-500" role="status">Loading model center…</p>}>
      <ModelCenterPageImpl />
    </Suspense>
  );
}
