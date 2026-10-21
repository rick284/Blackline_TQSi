/**
 * The Gantt chart's timescale, with no screen in it: how far a moment is across the chart, the two tiers of labels (as MS Project's
 * Timescale shows them), the stretches of non-working time, and the zoom steps.
 */
import { gantt as G } from "@blackline/tender/core";

export type Zoom = "quarters" | "months" | "weeks" | "days";
/** Coarse to fine, so zooming in is moving right along the list. */
export const ZOOMS: Zoom[] = ["quarters", "months", "weeks", "days"];
export const PX_PER_DAY: Record<Zoom, number> = { quarters: 0.9, months: 2.6, weeks: 9, days: 32 };
export const ROW_H = 24;
export const TIER_H = 20;

const DAY = 1440;
export interface Scale { zoom: Zoom; startMin: number; endMin: number; pxPerMin: number; width: number }
export interface Tick { x: number; w: number; label: string }

export const zoomIn = (z: Zoom): Zoom => ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS.indexOf(z) + 1)]!;
export const zoomOut = (z: Zoom): Zoom => ZOOMS[Math.max(0, ZOOMS.indexOf(z) - 1)]!;

const utc = (t: number) => new Date(t * 60000);
const minOf = (y: number, m: number, d: number) => Date.UTC(y, m, d) / 60000;
/** Monday on or before the day containing t. */
const weekStart = (t: number) => { const d = utc(t); const back = (d.getUTCDay() + 6) % 7; return minOf(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back); };
const monthStart = (t: number) => { const d = utc(t); return minOf(d.getUTCFullYear(), d.getUTCMonth(), 1); };
const quarterStart = (t: number) => { const d = utc(t); return minOf(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1); };
const yearStart = (t: number) => minOf(utc(t).getUTCFullYear(), 0, 1);
const nextMonth = (t: number) => { const d = utc(t); return minOf(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); };
const nextQuarter = (t: number) => { const d = utc(t); return minOf(d.getUTCFullYear(), d.getUTCMonth() + 3, 1); };
const nextYear = (t: number) => minOf(utc(t).getUTCFullYear() + 1, 0, 1);

/** A scale covering [first, last] with a margin, starting on a clean unit boundary for the zoom. */
export function makeScale(zoom: Zoom, first: number, last: number, minWidth = 0): Scale {
  const pad = zoom === "days" ? 3 * DAY : zoom === "weeks" ? 10 * DAY : zoom === "months" ? 30 * DAY : 90 * DAY;
  const startMin = zoom === "days" || zoom === "weeks" ? weekStart(first - pad) : zoom === "months" ? monthStart(first - pad) : quarterStart(first - pad);
  const pxPerMin = PX_PER_DAY[zoom] / DAY;
  let endMin = last + pad * 2;
  endMin = Math.max(endMin, startMin + (minWidth / pxPerMin));
  return { zoom, startMin, endMin, pxPerMin, width: Math.ceil((endMin - startMin) * pxPerMin) };
}

export const xOf = (s: Scale, t: number) => (t - s.startMin) * s.pxPerMin;
export const tOf = (s: Scale, x: number) => s.startMin + x / s.pxPerMin;

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOW = ["S", "M", "T", "W", "T", "F", "S"];

/** The two tiers of labels along the top. */
export function tiers(s: Scale): { top: Tick[]; bottom: Tick[] } {
  const top: Tick[] = [], bottom: Tick[] = [];
  const push = (list: Tick[], a: number, b: number, label: string) => list.push({ x: xOf(s, a), w: (b - a) * s.pxPerMin, label });
  const walk = (from: number, next: (t: number) => number, label: (t: number) => string, list: Tick[]) => {
    for (let t = from; t < s.endMin; ) { const n = next(t); push(list, t, n, label(t)); t = n; }
  };
  const lbl = (t: number) => { const d = utc(t); return `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`; };
  if (s.zoom === "days") {
    walk(s.startMin, (t) => weekStart(t) + 7 * DAY > t ? weekStart(t) + 7 * DAY : t + 7 * DAY, lbl, top);
    walk(s.startMin, (t) => t + DAY, (t) => DOW[utc(t).getUTCDay()]!, bottom);
  } else if (s.zoom === "weeks") {
    walk(monthStart(s.startMin), nextMonth, (t) => `${MON[utc(t).getUTCMonth()]} ${utc(t).getUTCFullYear()}`, top);
    walk(s.startMin, (t) => t + 7 * DAY, (t) => String(utc(t).getUTCDate()), bottom);
  } else if (s.zoom === "months") {
    walk(yearStart(s.startMin), nextYear, (t) => String(utc(t).getUTCFullYear()), top);
    walk(s.startMin, nextMonth, (t) => MON[utc(t).getUTCMonth()]!, bottom);
  } else {
    walk(yearStart(s.startMin), nextYear, (t) => String(utc(t).getUTCFullYear()), top);
    walk(s.startMin, nextQuarter, (t) => `Q${Math.floor(utc(t).getUTCMonth() / 3) + 1}`, bottom);
  }
  // the first tick of a tier may begin before the scale does
  for (const list of [top, bottom]) for (const t of list) if (t.x < 0) { t.w += t.x; t.x = 0; }
  return { top, bottom };
}

/** Stretches of days with no working time, as x ranges, merged: only drawn when days are wide enough to see (days and weeks zoom). */
export function nonWorking(cal: G.GCalendar, s: Scale): { x: number; w: number }[] {
  if (s.zoom === "months" || s.zoom === "quarters") return [];
  const wc = new G.WorkCalendar(cal);
  const out: { x: number; w: number }[] = [];
  for (let day = Math.floor(s.startMin / DAY) * DAY; day < s.endMin; day += DAY) {
    if (wc.windows(day).length) continue;
    const x = xOf(s, day), w = DAY * s.pxPerMin;
    const last = out[out.length - 1];
    if (last && Math.abs(last.x + last.w - x) < 0.01) last.w += w; else out.push({ x, w });
  }
  return out;
}

/** The rows on show: everything except what is inside a collapsed summary. */
export function visibleRows<T extends { task: { uid: number; outline: number } }>(rows: T[], collapsed: Set<number>): T[] {
  const out: T[] = [];
  let hideBelow = Infinity;
  for (const r of rows) {
    const level = Math.max(1, r.task.outline);
    if (level > hideBelow) continue;
    hideBelow = Infinity;
    out.push(r);
    if (collapsed.has(r.task.uid)) hideBelow = level;
  }
  return out;
}
