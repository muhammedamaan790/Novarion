// The Model Evidence page and its chart engine (Recharts via shadcn/ui charts, ~400 kB) load only when the page is
// opened, so the app shell stays small for every other page.
import { Suspense, lazy } from "react";

const EvidencePageImpl = lazy(() => import("./EvidencePage").then((m) => ({ default: m.EvidencePage })));

export function EvidencePage() {
  return (
    <Suspense fallback={<p className="p-6 text-sm text-slate-500" role="status">Loading model evidence…</p>}>
      <EvidencePageImpl />
    </Suspense>
  );
}
