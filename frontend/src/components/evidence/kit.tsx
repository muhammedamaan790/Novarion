// Shared parts of the Model Evidence page: one card shell, one info-tooltip pattern, one export pattern and one
// dot-and-interval chart (shadcn chart + Recharts), so every tab reads the same way. Formatting never invents a value:
// a missing number renders as missing, and a count is shown only when it is exact (share × n is a whole number).
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { CartesianGrid, ErrorBar, ReferenceLine, Scatter, ScatterChart, XAxis, YAxis } from "recharts";
import { ChartContainer, type ChartConfig } from "../ui/chart";
import { cn } from "../../lib/utils";

// Validated categorical palette (dataviz validator, light); grey for comparators.
export const C = { primary: "#2a78d6", second: "#1baf7a", third: "#eda100", muted: "#64748b", outside: "#cbd5e1" };
export const N_FOLDS = 25;

export const pct1 = (v: number | null | undefined) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);
export const f2 = (v: number) => (Math.abs(v) < 0.005 ? 0 : v).toFixed(2); // never "-0.00"
export const f3 = (v: number) => v.toFixed(3);
export const signed3 = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(3)}`;

/** share × n as a count, only when it is exact (shares here are k/n); otherwise null rather than a rounded guess. */
export function countOf(share: number | null | undefined, n: number | null | undefined): number | null {
  if (share == null || n == null) return null;
  const k = share * n;
  return Math.abs(k - Math.round(k)) < 1e-6 ? Math.round(k) : null;
}

export function InfoTip({ text, label = "What this means" }: { text: ReactNode; label?: string }) {
  const id = useId();
  return (
    <span className="group relative inline-flex align-middle">
      <button type="button" aria-label={label} aria-describedby={id}
              className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold leading-none text-slate-500 ring-1 ring-slate-300 hover:text-slate-900 hover:ring-slate-500 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-sky-600">
        i
      </button>
      <span role="tooltip" id={id}
            className="pointer-events-none invisible absolute left-1/2 top-full z-30 mt-1.5 w-64 max-w-[80vw] -translate-x-1/2 rounded-md bg-slate-900 px-2.5 py-2 text-left text-xs font-normal normal-case leading-snug tracking-normal text-white opacity-0 shadow-lg transition-opacity group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100">
        {text}
      </span>
    </span>
  );
}

type Row = Record<string, string | number | boolean | null | undefined>;

function toCsv(rows: Row[]): string {
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const esc = (v: Row[string]) => {
    if (v == null) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n") + "\n";
}

function download(name: string, body: string, type: string) {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Downloads exactly the rows a chart or table draws (unrounded), as CSV or JSON. */
export function ExportButtons({ name, rows, meta }: { name: string; rows: Row[]; meta?: Record<string, unknown> }) {
  if (!rows.length) return null;
  const btn = "rounded px-1.5 py-0.5 text-[11px] font-semibold text-slate-600 ring-1 ring-slate-300 hover:bg-slate-50 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-sky-600";
  return (
    <span className="flex shrink-0 items-center gap-1" aria-label={`Export ${name} data`} role="group">
      <button type="button" className={btn} data-testid={`export-${name}-csv`}
              onClick={() => download(`novarion-${name}.csv`, toCsv(rows), "text/csv")}>CSV</button>
      <button type="button" className={btn} data-testid={`export-${name}-json`}
              onClick={() => download(`novarion-${name}.json`, JSON.stringify({ ...meta, rows }, null, 2) + "\n", "application/json")}>
        JSON
      </button>
    </span>
  );
}

export function Card({ title, subtitle, info, actions, children, className, testId, label }: {
  title: ReactNode; subtitle?: ReactNode; info?: ReactNode; actions?: ReactNode; children: ReactNode;
  className?: string; testId?: string; label?: string;
}) {
  return (
    <section className={cn("min-w-0 rounded-lg border border-slate-200 bg-white p-4", className)} data-testid={testId}
             aria-label={label ?? (typeof title === "string" ? title : undefined)}>
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <h2 className="text-base font-bold text-slate-900">{title}{info && <InfoTip text={info} />}</h2>
          {subtitle && <p className="mt-0.5 text-xs text-slate-600">{subtitle}</p>}
        </div>
        {actions}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** A value that does not exist for a stated reason, never a stand-in number. */
export function Unavailable({ children }: { children: ReactNode }) {
  return <span className="text-xs font-medium italic text-slate-500">{children}</span>;
}

export interface DotRow {
  key: string;
  label: ReactNode;
  value: number | null;
  lo?: number | null;
  hi?: number | null;
  right: ReactNode;
  highlight?: boolean;
  muted?: boolean;
  testId?: string;
  ariaLabel?: string;
}

const AXIS_H = 40;
const TOP = 4;
const COMPACT_COLS = "5.75rem minmax(0,1fr) 4.5rem";

/** True when the element is narrower than `px` (phones): the forest charts then give the plot more of the row. */
function useNarrow<T extends HTMLElement>(px: number) {
  const ref = useRef<T>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setNarrow((e?.contentRect.width ?? px) < px));
    ro.observe(el);
    return () => ro.disconnect();
  }, [px]);
  return { ref, narrow };
}

/**
 * Dot-and-interval (forest) chart: labels and values are HTML columns aligned to the plot rows, so text stays crisp and
 * readable at any width. With `onSelect` each row is a real button (keyboard and screen-reader operable).
 */
export function DotIntervalChart({ rows, domain, ticks, tickFormat = f2, reference, xLabel, color = C.primary,
  rowHeight = 34, cols: wideCols = "minmax(4.5rem,8rem) minmax(0,1fr) minmax(6.5rem,9rem)", onSelect, ariaLabel }: {
  rows: DotRow[]; domain: [number, number]; ticks: number[]; tickFormat?: (v: number) => string;
  reference?: { x: number; label?: string }; xLabel: string; color?: string; rowHeight?: number; cols?: string;
  onSelect?: (key: string) => void; ariaLabel: string;
}) {
  const { ref, narrow } = useNarrow<HTMLDivElement>(560);
  const cols = narrow ? COMPACT_COLS : wideCols;
  const n = rows.length;
  const height = TOP + n * rowHeight + AXIS_H;
  const pts = rows.flatMap((r, i) => r.value == null ? [] : [{
    y: i, value: r.value, highlight: !!r.highlight, muted: !!r.muted,
    err: r.lo != null && r.hi != null ? [Math.max(0, r.value - r.lo), Math.max(0, r.hi - r.value)] : undefined,
  }]);
  const config = { value: { label: xLabel, color } } satisfies ChartConfig;
  const Shape = (p: unknown) => {
    const { cx, cy, payload } = p as { cx?: number; cy?: number; payload?: { highlight: boolean; muted: boolean } };
    if (cx == null || cy == null) return <g />;
    const big = payload?.highlight;
    return (
      <circle cx={cx} cy={cy} r={big ? 7.5 : 6} stroke="#fff" strokeWidth={2}
              fill={payload?.muted ? C.muted : "var(--color-value)"} />
    );
  };
  const Row = onSelect ? "button" : "div";
  return (
    <div ref={ref} className="relative w-full" style={{ height }} role={onSelect ? "group" : "img"} aria-label={ariaLabel}>
      <div className="absolute inset-0 grid" style={{ gridTemplateColumns: cols }} aria-hidden>
        <div />
        <ChartContainer config={config} className="aspect-auto h-full w-full">
          <ScatterChart margin={{ top: TOP, right: 20, bottom: 0, left: 20 }} accessibilityLayer={false} tabIndex={-1}>
            <CartesianGrid horizontal={false} />
            <XAxis type="number" dataKey="value" domain={domain} ticks={ticks} interval="preserveStartEnd" minTickGap={6} allowDataOverflow tickLine={false}
                   tickFormatter={tickFormat} height={AXIS_H}
                   label={{ value: xLabel, position: "insideBottom", offset: 2, className: "fill-slate-600 text-[11px]" }} />
            <YAxis type="number" dataKey="y" domain={[-0.5, n - 0.5]} reversed hide />
            {reference && (
              <ReferenceLine x={reference.x} stroke="#64748b" strokeDasharray="4 3" ifOverflow="hidden" />
            )}
            <Scatter data={pts} shape={Shape} isAnimationActive={false}>
              <ErrorBar dataKey="err" direction="x" width={0} strokeWidth={2.5} stroke="var(--color-value)" />
            </Scatter>
          </ScatterChart>
        </ChartContainer>
        <div />
      </div>
      {rows.map((r, i) => (
        <Row key={r.key} data-testid={r.testId}
             {...(onSelect ? { type: "button" as const, onClick: () => onSelect(r.key), "aria-label": r.ariaLabel } : {})}
             className={cn("absolute inset-x-0 grid items-center rounded-md text-left",
               onSelect && "hover:bg-slate-900/[0.04] focus-visible:outline-2 focus-visible:outline-sky-600",
               r.highlight && "bg-sky-500/[0.09]")}
             style={{ top: TOP + i * rowHeight, height: rowHeight, gridTemplateColumns: cols }}>
          <span className={cn("min-w-0 pl-2 text-sm", narrow ? "line-clamp-2 pl-1 text-[11px] leading-tight [&_span]:text-[10px]" : "truncate", r.highlight ? "font-bold text-slate-900" : "font-medium text-slate-700")}>
            {r.label}
          </span>
          <span aria-hidden />
          <span className={cn("pr-2 text-right text-xs leading-tight tabular-nums text-slate-700", narrow && "pr-1 [&_.text-sm]:text-xs")}>{r.right}</span>
        </Row>
      ))}
    </div>
  );
}
