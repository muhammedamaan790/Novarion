// Minimal SVG line chart for the Model Evidence page (dataviz method): one y-axis, 2px lines, recessive grid,
// bootstrap bands as low-opacity areas, direct end labels + legend, crosshair tooltip on hover.
import { useMemo, useState, type ReactNode } from "react";

export interface Series {
  id: string;
  label: string;
  color: string;
  x: number[];
  y: (number | null)[];
  lo?: (number | null)[];
  hi?: (number | null)[];
  dashed?: boolean;
  points?: boolean; // markers instead of a line (reliability)
}

export interface VLine {
  x: number;
  label: string;
}

interface Props {
  title: string;
  caption: string;
  xLabel: string;
  yLabel: string;
  series: Series[];
  diagonal?: boolean;
  hline?: { y: number; label: string };
  vlines?: VLine[];
  formatX?: (x: number) => string;
  formatY?: (y: number) => string;
  footer?: ReactNode;
}

const W = 320;
const H = 230;
const M = { top: 12, right: 56, bottom: 38, left: 42 };
const IW = W - M.left - M.right;
const IH = H - M.top - M.bottom;
const sx = (x: number) => M.left + x * IW;
const sy = (y: number) => M.top + (1 - y) * IH;
const TICKS = [0, 0.25, 0.5, 0.75, 1];
const pct = (v: number) => `${Math.round(v * 100)}%`;

function path(x: number[], y: (number | null)[]): string {
  let d = "";
  let pen = false;
  x.forEach((xv, i) => {
    const yv = y[i];
    if (yv == null) {
      pen = false;
      return;
    }
    d += `${pen ? "L" : "M"}${sx(xv).toFixed(1)},${sy(yv).toFixed(1)}`;
    pen = true;
  });
  return d;
}

function band(x: number[], lo: (number | null)[], hi: (number | null)[]): string {
  const idx = x.map((_, i) => i).filter((i) => lo[i] != null && hi[i] != null);
  if (idx.length < 2) return "";
  const top = idx.map((i) => `${sx(x[i]!).toFixed(1)},${sy(hi[i]!).toFixed(1)}`);
  const bottom = [...idx].reverse().map((i) => `${sx(x[i]!).toFixed(1)},${sy(lo[i]!).toFixed(1)}`);
  return `M${top.join("L")}L${bottom.join("L")}Z`;
}

export function LineChart({
  title, caption, xLabel, yLabel, series, diagonal, hline, vlines = [], formatX = pct, formatY = pct, footer,
}: Props) {
  const [hoverX, setHoverX] = useState<number | null>(null);
  const xs = useMemo(() => series[0]?.x ?? [], [series]);
  const nearest = (x: number) => xs.reduce((best, v, i) => (Math.abs(v - x) < Math.abs(xs[best]! - x) ? i : best), 0);
  const hi = hoverX == null ? null : nearest(hoverX);

  return (
    <figure className="rounded-lg border border-slate-200 bg-white p-3">
      <figcaption className="mb-1">
        <span className="block text-sm font-semibold text-slate-900">{title}</span>
        <span className="block text-[11px] text-slate-500">{caption}</span>
      </figcaption>
      {series.length > 1 && (
        <div className="mb-1 flex flex-wrap gap-3 text-[11px] text-slate-600" aria-hidden>
          {series.map((s) => (
            <span key={s.id} className="flex items-center gap-1">
              <svg width="18" height="6">
                <line x1="0" y1="3" x2="18" y2="3" stroke={s.color} strokeWidth="2" strokeDasharray={s.dashed ? "4 3" : undefined} />
              </svg>
              {s.label}
            </span>
          ))}
        </div>
      )}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label={`${title}. ${caption}`}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const x = ((e.clientX - r.left) / r.width) * W;
          setHoverX(x < M.left || x > M.left + IW ? null : (x - M.left) / IW);
        }}
        onMouseLeave={() => setHoverX(null)}
      >
        {TICKS.map((t) => (
          <g key={t}>
            <line x1={M.left} x2={M.left + IW} y1={sy(t)} y2={sy(t)} stroke="#eef0f3" />
            <text x={M.left - 6} y={sy(t) + 3} textAnchor="end" className="fill-slate-500 text-[9px]">
              {formatY(t)}
            </text>
            <text x={sx(t)} y={M.top + IH + 13} textAnchor="middle" className="fill-slate-500 text-[9px]">
              {formatX(t)}
            </text>
          </g>
        ))}
        <line x1={M.left} x2={M.left + IW} y1={sy(0)} y2={sy(0)} stroke="#94a3b8" />
        <text x={M.left + IW / 2} y={H - 6} textAnchor="middle" className="fill-slate-600 text-[10px]">{xLabel}</text>
        <text transform={`translate(10 ${M.top + IH / 2}) rotate(-90)`} textAnchor="middle" className="fill-slate-600 text-[10px]">
          {yLabel}
        </text>
        {diagonal && (
          <line x1={sx(0)} y1={sy(0)} x2={sx(1)} y2={sy(1)} stroke="#94a3b8" strokeDasharray="3 3" strokeWidth="1" />
        )}
        {hline && (
          <g>
            <line x1={sx(0)} x2={sx(1)} y1={sy(hline.y)} y2={sy(hline.y)} stroke="#94a3b8" strokeDasharray="3 3" />
            <text x={sx(1) + 4} y={sy(hline.y) + 3} className="fill-slate-500 text-[9px]">{hline.label}</text>
          </g>
        )}
        {vlines.map((v, i) => (
          <g key={v.label}>
            <line x1={sx(v.x)} x2={sx(v.x)} y1={M.top} y2={M.top + IH} stroke="#475569" strokeDasharray="2 3" />
            <text x={sx(v.x) + 3} y={M.top + 9 + i * 10} className="fill-slate-600 text-[9px]">{v.label}</text>
          </g>
        ))}
        {series.map((s) =>
          s.lo && s.hi && !s.points ? <path key={`${s.id}-band`} d={band(s.x, s.lo, s.hi)} fill={s.color} opacity={0.14} /> : null,
        )}
        {series.map((s) =>
          s.points ? (
            <g key={s.id}>
              {s.x.map((xv, i) => {
                const yv = s.y[i];
                if (yv == null) return null;
                return (
                  <g key={i}>
                    {s.lo?.[i] != null && s.hi?.[i] != null && (
                      <line x1={sx(xv)} x2={sx(xv)} y1={sy(s.lo[i]!)} y2={sy(s.hi[i]!)} stroke={s.color} strokeWidth="2" />
                    )}
                    <circle cx={sx(xv)} cy={sy(yv)} r="4.5" fill={s.color} stroke="#ffffff" strokeWidth="2" />
                  </g>
                );
              })}
            </g>
          ) : (
            <g key={s.id}>
              <path d={path(s.x, s.y)} fill="none" stroke={s.color} strokeWidth="2" strokeDasharray={s.dashed ? "5 4" : undefined} />
              {(() => {
                const last = s.y.map((v, i) => [v, i] as const).filter(([v]) => v != null).pop();
                return last && series.length > 1 ? (
                  <text x={sx(s.x[last[1]]!) + 4} y={sy(last[0]!) + 3} className="fill-slate-700 text-[9px]">{s.label}</text>
                ) : null;
              })()}
            </g>
          ),
        )}
        {hi != null && (
          <g pointerEvents="none">
            <line x1={sx(xs[hi]!)} x2={sx(xs[hi]!)} y1={M.top} y2={M.top + IH} stroke="#0f172a" strokeWidth="1" opacity={0.4} />
            {series.map((s) => (s.y[hi] == null ? null : (
              <circle key={s.id} cx={sx(s.x[hi]!)} cy={sy(s.y[hi]!)} r="4" fill={s.color} stroke="#fff" strokeWidth="2" />
            )))}
          </g>
        )}
      </svg>
      {hi != null && (
        <p className="mt-1 text-[11px] tabular-nums text-slate-700" role="status">
          {xLabel} {formatX(xs[hi]!)} ·{" "}
          {series.map((s) => `${s.label} ${s.y[hi] == null ? "n/a" : formatY(s.y[hi]!)}`
            + (s.lo?.[hi] != null && s.hi?.[hi] != null ? ` [${formatY(s.lo[hi]!)}–${formatY(s.hi[hi]!)}]` : "")).join(" · ")}
        </p>
      )}
      {footer}
    </figure>
  );
}
