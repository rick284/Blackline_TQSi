import { forwardRef, useMemo, useRef, useState } from "react";
import { gantt as G } from "@blackline/tender/core";
import { ROW_H, TIER_H, nonWorking, tiers, xOf, type Scale } from "../lib/ganttView.js";

export interface ChartRow { task: G.GTask; s: G.ScheduledTask }
export type End = "start" | "finish";

interface Props {
  rows: ChartRow[];
  scale: Scale;
  calendar: G.GCalendar;
  selected: Set<number>;
  showBaseline: boolean;
  showCritical: boolean;
  today: number | null;
  statusDate: number | null;
  readOnly: boolean;
  onSelect: (uid: number, mode: "one" | "toggle" | "range") => void;
  /** Moved by whole days (calendar days) */
  onMove: (uid: number, days: number) => void;
  /** Right edge moved by whole days */
  onResize: (uid: number, days: number) => void;
  onLink: (from: number, fromEnd: End, to: number, toEnd: End) => void;
  onScroll: (top: number) => void;
}

type Drag =
  | { kind: "move" | "resize"; uid: number; x0: number; dx: number }
  | { kind: "link"; uid: number; end: End; x0: number; y0: number; x: number; y: number };

const BAR_H = 12;
const INK = "#000", GREY = "#8a8a8a", LIGHT = "#bdbdbd", NONWORK = "#efefef", SEL = "#d9d9d9";

/** The timeline: two-tier timescale, non-working time, today line, bars, summary brackets, milestones, link arrows, baseline marks. */
export const GanttChart = forwardRef<HTMLDivElement, Props>(function GanttChart(p, ref) {
  const { rows, scale } = p;
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const pxDay = scale.pxPerMin * 1440;
  const head = useMemo(() => tiers(scale), [scale]);
  const shade = useMemo(() => nonWorking(p.calendar, scale), [p.calendar, scale]);
  const idx = useMemo(() => new Map(rows.map((r, i) => [r.task.uid, i])), [rows]);
  const height = Math.max(rows.length * ROW_H, 1);

  const geom = (r: ChartRow, i: number) => {
    let x1 = xOf(scale, r.s.startMin), x2 = xOf(scale, r.s.finishMin);
    if (drag && drag.kind !== "link" && drag.uid === r.task.uid) {
      const d = Math.round(drag.dx / pxDay) * pxDay;
      if (drag.kind === "move") { x1 += d; x2 += d; } else x2 = Math.max(x1 + 2, x2 + d);
    }
    return { x1, x2: Math.max(x2, x1 + (r.task.milestone ? 0 : 2)), y: i * ROW_H };
  };

  const point = (e: React.PointerEvent) => { const b = svgRef.current!.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; };
  const begin = (e: React.PointerEvent, d: Drag) => {
    if (p.readOnly) return;
    e.stopPropagation();
    (svgRef.current as SVGSVGElement).setPointerCapture(e.pointerId);
    setDrag(d);
  };
  const move = (e: React.PointerEvent) => {
    if (!drag) return;
    const q = point(e);
    setDrag(drag.kind === "link" ? { ...drag, x: q.x, y: q.y } : { ...drag, dx: q.x - drag.x0 });
  };
  const end = (e: React.PointerEvent) => {
    if (!drag) return;
    const d = drag;
    setDrag(null);
    if (d.kind === "link") {
      const el = (document.elementFromPoint(e.clientX, e.clientY) as Element | null)?.closest("[data-bar]") as SVGElement | null;
      if (el) {
        const to = Number(el.getAttribute("data-bar"));
        const b = el.getBoundingClientRect();
        const toEnd: End = e.clientX < b.left + b.width / 2 ? "start" : "finish";
        if (to !== d.uid) p.onLink(d.uid, d.end, to, toEnd);
      }
      return;
    }
    const days = Math.round((point(e).x - d.x0) / pxDay);
    if (days !== 0) (d.kind === "move" ? p.onMove : p.onResize)(d.uid, days);
  };

  const elbow = (x1: number, y1: number, x2: number, y2: number, fromRight: boolean, toRight: boolean) => {
    const out = fromRight ? 8 : -8, into = toRight ? 8 : -8;
    const xa = x1 + out, xb = x2 + into;
    const dir = y2 >= y1 ? 1 : -1;
    // go out of the first bar, across, and into the second from the side it is linked at
    if ((fromRight && !toRight && xb >= xa) || (!fromRight && toRight && xb <= xa)) return `M${x1},${y1} H${xa} V${y2} H${x2}`;
    return `M${x1},${y1} H${xa} V${y1 + dir * (ROW_H / 2)} H${xb} V${y2} H${x2}`;
  };

  const lines = useMemo(() => {
    const out: { key: string; d: string; head: { x: number; y: number; left: boolean }; critical: boolean }[] = [];
    for (const r of rows) {
      const j = idx.get(r.task.uid)!;
      for (const l of r.task.links) {
        const pi = idx.get(l.uid);
        if (pi === undefined) continue;
        const pr = rows[pi]!;
        const fromEnd: End = l.type === "FS" || l.type === "FF" ? "finish" : "start";
        const toEnd: End = l.type === "FS" || l.type === "SS" ? "start" : "finish";
        const x1 = xOf(scale, fromEnd === "finish" ? pr.s.finishMin : pr.s.startMin), x2 = xOf(scale, toEnd === "finish" ? r.s.finishMin : r.s.startMin);
        const y1 = pi * ROW_H + ROW_H / 2, y2 = j * ROW_H + ROW_H / 2;
        out.push({ key: `${l.uid}-${r.task.uid}`, d: elbow(x1, y1, x2, y2, fromEnd === "finish", toEnd === "finish"), head: { x: x2, y: y2, left: toEnd === "finish" }, critical: pr.s.critical && r.s.critical });
      }
    }
    return out;
  }, [rows, idx, scale]); // eslint-disable-line react-hooks/exhaustive-deps

  const drawRowBg = (r: ChartRow, i: number) => (
    <rect key={`bg${r.task.uid}`} x={0} y={i * ROW_H} width={scale.width} height={ROW_H} fill={p.selected.has(r.task.uid) ? SEL : i % 2 ? "#fafafa" : "#fff"} stroke="#e6e6e6" strokeWidth={0.5}
      onClick={(e) => p.onSelect(r.task.uid, e.ctrlKey || e.metaKey ? "toggle" : e.shiftKey ? "range" : "one")} />
  );

  const drawBar = (r: ChartRow, i: number) => {
    const { x1, x2, y } = geom(r, i);
    const cy = y + ROW_H / 2;
    const crit = p.showCritical && r.s.critical;
    const off = !r.task.active;
    const sel = (e: React.PointerEvent) => p.onSelect(r.task.uid, e.ctrlKey || e.metaKey ? "toggle" : e.shiftKey ? "range" : "one");
    const base = r.task.baseline && p.showBaseline ? (
      <rect x={xOf(scale, G.toMin(r.task.baseline.start))} y={y + ROW_H - 6} width={Math.max(2, xOf(scale, G.toMin(r.task.baseline.finish)) - xOf(scale, G.toMin(r.task.baseline.start)))} height={3} fill={LIGHT} stroke="#999" strokeWidth={0.5} />
    ) : null;
    if (r.s.summary) {
      return (
        <g key={`b${r.task.uid}`} data-bar={r.task.uid} opacity={off ? 0.4 : 1} onPointerDown={sel}>
          {base}
          <rect x={x1} y={cy - 5} width={Math.max(2, x2 - x1)} height={6} fill={INK} />
          <path d={`M${x1},${cy + 1} v5 l5,-5 z`} fill={INK} />
          <path d={`M${x2},${cy + 1} v5 l-5,-5 z`} fill={INK} />
          {r.s.percent > 0 && <rect x={x1} y={cy - 2} width={Math.max(0, (x2 - x1) * r.s.percent / 100)} height={2} fill="#fff" />}
        </g>
      );
    }
    if (r.task.milestone) {
      return (
        <g key={`b${r.task.uid}`} data-bar={r.task.uid} opacity={off ? 0.4 : 1} onPointerDown={(e) => { sel(e); begin(e, { kind: "move", uid: r.task.uid, x0: point(e).x, dx: 0 }); }} style={{ cursor: p.readOnly ? "default" : "grab" }}>
          {base}
          <path d={`M${x1},${cy - 7} l7,7 l-7,7 l-7,-7 z`} fill={crit ? INK : "#fff"} stroke={INK} strokeWidth={1.5} />
        </g>
      );
    }
    const w = Math.max(2, x2 - x1);
    return (
      <g key={`b${r.task.uid}`} opacity={off ? 0.4 : 1}>
        {base}
        <rect data-bar={r.task.uid} x={x1} y={cy - BAR_H / 2} width={w} height={BAR_H} fill={crit ? INK : GREY} stroke={INK} strokeWidth={1} style={{ cursor: p.readOnly ? "default" : "grab" }}
          onPointerDown={(e) => { sel(e); begin(e, { kind: "move", uid: r.task.uid, x0: point(e).x, dx: 0 }); }} />
        {r.s.percent > 0 && <rect x={x1} y={cy - 2} width={Math.max(0, w * r.s.percent / 100)} height={4} fill={crit ? "#fff" : INK} pointerEvents="none" />}
        {!p.readOnly && <rect x={x2 - 4} y={cy - BAR_H / 2} width={5} height={BAR_H} fill="transparent" style={{ cursor: "ew-resize" }} onPointerDown={(e) => begin(e, { kind: "resize", uid: r.task.uid, x0: point(e).x, dx: 0 })} />}
        {!p.readOnly && (
          <>
            <circle cx={x1 - 5} cy={cy} r={3} fill="#fff" stroke={INK} className="link-handle" style={{ cursor: "crosshair" }} onPointerDown={(e) => begin(e, { kind: "link", uid: r.task.uid, end: "start", x0: x1, y0: cy, x: x1, y: cy })} />
            <circle cx={x2 + 6} cy={cy} r={3} fill="#fff" stroke={INK} className="link-handle" style={{ cursor: "crosshair" }} onPointerDown={(e) => begin(e, { kind: "link", uid: r.task.uid, end: "finish", x0: x2, y0: cy, x: x2, y: cy })} />
          </>
        )}
      </g>
    );
  };

  return (
    <div className="gantt-scroll" ref={ref} onScroll={(e) => p.onScroll((e.target as HTMLDivElement).scrollTop)}>
      <div className="gantt-head" style={{ width: scale.width }}>
        <svg width={scale.width} height={TIER_H * 2} role="img" aria-label="Timescale">
          {head.top.map((t, i) => (
            <g key={`t${i}`}><rect x={t.x} y={0} width={t.w} height={TIER_H} fill="#dcdcdc" stroke="#aaa" strokeWidth={0.5} /><text x={t.x + 4} y={14} fontSize={11} fill="#111">{t.w > 30 ? t.label : ""}</text></g>
          ))}
          {head.bottom.map((t, i) => (
            <g key={`u${i}`}><rect x={t.x} y={TIER_H} width={t.w} height={TIER_H} fill="#ececec" stroke="#aaa" strokeWidth={0.5} /><text x={t.x + t.w / 2} y={TIER_H + 14} fontSize={10} textAnchor="middle" fill="#333">{t.w > 9 ? t.label : ""}</text></g>
          ))}
        </svg>
      </div>
      <svg ref={svgRef} width={scale.width} height={height} onPointerMove={move} onPointerUp={end} onPointerCancel={() => setDrag(null)} style={{ display: "block", touchAction: "none" }} role="img" aria-label="Gantt chart">
        {rows.map(drawRowBg)}
        {shade.map((s, i) => <rect key={`n${i}`} x={s.x} y={0} width={s.w} height={height} fill={NONWORK} opacity={0.7} pointerEvents="none" />)}
        {head.bottom.map((t, i) => <line key={`g${i}`} x1={t.x} x2={t.x} y1={0} y2={height} stroke="#e0e0e0" strokeWidth={0.5} pointerEvents="none" />)}
        {p.today !== null && <line x1={xOf(scale, p.today)} x2={xOf(scale, p.today)} y1={0} y2={height} stroke={INK} strokeWidth={1} strokeDasharray="4 3" pointerEvents="none"><title>Today</title></line>}
        {p.statusDate !== null && <line x1={xOf(scale, p.statusDate)} x2={xOf(scale, p.statusDate)} y1={0} y2={height} stroke="#666" strokeWidth={1.5} pointerEvents="none"><title>Status date</title></line>}
        {lines.map((l) => (
          <g key={l.key} pointerEvents="none">
            <path d={l.d} fill="none" stroke={l.critical && p.showCritical ? INK : "#555"} strokeWidth={l.critical && p.showCritical ? 1.4 : 1} />
            <path d={l.head.left ? `M${l.head.x},${l.head.y} l6,-3 v6 z` : `M${l.head.x},${l.head.y} l-6,-3 v6 z`} fill={l.critical && p.showCritical ? INK : "#555"} />
          </g>
        ))}
        {rows.map(drawBar)}
        {drag?.kind === "link" && <line x1={drag.x0} y1={drag.y0} x2={drag.x} y2={drag.y} stroke={INK} strokeWidth={1.5} strokeDasharray="3 2" pointerEvents="none" />}
      </svg>
    </div>
  );
});
