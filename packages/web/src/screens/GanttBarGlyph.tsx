import { ROW_H } from "../lib/ganttView.js";
import type { EndShape, Resolved } from "../lib/ganttBars.js";

/** The id of the hatch or dot pattern a bar format needs (none for the other shapes). */
export const patternId = (f: Resolved) => (f.shape === "hatched" || f.shape === "dotted" ? `pat-${f.shape}-${f.fill.slice(1)}-${f.border.slice(1)}` : null);

/** The patterns for a set of bar formats, once each. */
export function Patterns({ formats }: { formats: Resolved[] }) {
  const seen = new Map<string, Resolved>();
  for (const f of formats) { const id = patternId(f); if (id && !seen.has(id)) seen.set(id, f); }
  if (!seen.size) return null;
  return (
    <defs>
      {[...seen].map(([id, f]) => (
        <pattern key={id} id={id} width={6} height={6} patternUnits="userSpaceOnUse" patternTransform={f.shape === "hatched" ? "rotate(45)" : undefined}>
          <rect width={6} height={6} fill={f.fill} />
          {f.shape === "hatched" ? <line x1={0} y1={0} x2={0} y2={6} stroke={f.border} strokeWidth={2} /> : <circle cx={3} cy={3} r={1.3} fill={f.border} />}
        </pattern>
      ))}
    </defs>
  );
}

/** A start or end marker centred on the bar's edge `x`. `side` says which end it is, so arrows point outward and triangles hang inward. */
function Marker({ shape, x, cy, side, f, solid }: { shape: EndShape; x: number; cy: number; side: "start" | "end"; f: Resolved; solid: boolean }) {
  const fill = solid ? f.fill : f.border, stroke = f.border;
  const dir = side === "start" ? 1 : -1;
  switch (shape) {
    case "diamond": return <path d={`M${x},${cy - 7} l7,7 l-7,7 l-7,-7 z`} fill={fill} stroke={stroke} strokeWidth={1.5} />;
    case "circle": return <circle cx={x} cy={cy} r={5.5} fill={fill} stroke={stroke} strokeWidth={1.5} />;
    case "square": return <rect x={x - 5} y={cy - 5} width={10} height={10} fill={fill} stroke={stroke} strokeWidth={1.5} />;
    case "triangle": return <path d={`M${x},${cy + 3} v7 l${6 * dir},-7 z`} fill={fill} stroke={stroke} strokeWidth={1} />;
    case "arrow": return <path d={`M${x},${cy - 5} v10 l${-8 * dir},-5 z`} fill={fill} stroke={stroke} strokeWidth={1} />;
    case "bracket": return <path d={`M${x + 4 * dir},${cy - 7} h${-4 * dir} v14 h${4 * dir}`} fill="none" stroke={stroke} strokeWidth={2} />;
    default: return null;
  }
}

/**
 * One bar, drawn from its resolved format: the middle (solid, thin, outline, hatched, dotted), the progress inside it, and the markers at its
 * ends. A milestone is its start marker alone. It draws only; the chart lays its own hit areas over it for dragging.
 */
export function BarGlyph({ f, x1, x2, cy, percent, kind }: { f: Resolved; x1: number; x2: number; cy: number; percent: number; kind: "task" | "summary" | "milestone" }) {
  if (kind === "milestone") {
    const m: EndShape = f.start === "none" || f.start === "arrow" || f.start === "bracket" ? "diamond" : f.start;
    return <g pointerEvents="none"><Marker shape={m} x={x1} cy={cy} side="start" f={f} solid /></g>;
  }
  const h = f.shape === "thin" ? 6 : 12;
  const w = Math.max(2, x2 - x1);
  const pid = patternId(f);
  const fill = f.shape === "outline" ? "#ffffff" : pid ? `url(#${pid})` : f.fill;
  return (
    <g pointerEvents="none">
      <rect x={x1} y={cy - h / 2} width={w} height={h} fill={fill} stroke={f.border} strokeWidth={f.shape === "outline" ? 1.5 : 1} />
      {percent > 0 && <rect x={x1} y={cy - (h === 6 ? 1 : 2)} width={Math.max(0, (w * percent) / 100)} height={h === 6 ? 2 : 4} fill={f.progress} />}
      <Marker shape={f.start} x={x1} cy={cy} side="start" f={f} solid={false} />
      <Marker shape={f.end} x={x2} cy={cy} side="end" f={f} solid={false} />
    </g>
  );
}

export const BAR_ROW = ROW_H;
