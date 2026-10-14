// The 3D view and its engine (three.js, React Three Fiber, drei: about 1 MB) load only when a page shows a heart, so
// sign-in, home, the library and the evidence pages do not download them.
import { Suspense, lazy, type ComponentProps } from "react";

const HeartViewImpl = lazy(() => import("./HeartView").then((m) => ({ default: m.HeartView })));

export function HeartView(props: ComponentProps<typeof HeartViewImpl>) {
  return (
    <Suspense fallback={
      <div className="flex h-full min-h-[420px] items-center justify-center rounded-lg border border-slate-200 bg-[#f4f5f7] text-sm text-slate-600"
           role="status">Loading the 3D view…</div>}>
      <HeartViewImpl {...props} />
    </Suspense>
  );
}
