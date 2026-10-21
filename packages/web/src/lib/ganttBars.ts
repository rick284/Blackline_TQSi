/**
 * Bar formatting for the Gantt chart, with no screen in it, after MS Project's Format Bar and Bar Styles. Three levels, each filling in what
 * the one above leaves out: the task's own format, the project's style for its kind (task, critical task, summary, milestone), and the usual.
 */
import { gantt as G } from "@blackline/tender/core";

export type BarFormat = G.BarFormat;
export type BarCategory = G.BarCategory;
export type BarShape = G.BarShape;
export type EndShape = G.EndShape;
export type Resolved = Required<BarFormat>;

export const CATEGORIES: { key: BarCategory; label: string }[] = [
  { key: "task", label: "Task" }, { key: "critical", label: "Critical task" }, { key: "summary", label: "Summary task" }, { key: "milestone", label: "Milestone" },
];
export const SHAPES: { key: BarShape; label: string }[] = [
  { key: "solid", label: "Solid bar" }, { key: "thin", label: "Thin bar" }, { key: "outline", label: "Outline" }, { key: "hatched", label: "Hatched" }, { key: "dotted", label: "Dotted" },
];
export const ENDS: { key: EndShape; label: string }[] = [
  { key: "none", label: "None" }, { key: "arrow", label: "Arrow" }, { key: "triangle", label: "Triangle" }, { key: "diamond", label: "Diamond" },
  { key: "circle", label: "Circle" }, { key: "square", label: "Square" }, { key: "bracket", label: "Bracket" },
];
/** What a milestone can be drawn as */
export const MARKERS: EndShape[] = ["diamond", "triangle", "circle", "square"];

/** Greys first, then colours. */
export const PALETTE = ["#000000", "#444444", "#8a8a8a", "#bdbdbd", "#ffffff", "#c0392b", "#e67e22", "#f1c40f", "#27ae60", "#16a085", "#2980b9", "#8e44ad"];

/** The usual look: the black, white and grey the rest of the app uses. */
export const USUAL: Record<BarCategory, Resolved> = {
  task: { shape: "solid", fill: "#8a8a8a", border: "#000000", progress: "#000000", start: "none", end: "none" },
  critical: { shape: "solid", fill: "#000000", border: "#000000", progress: "#ffffff", start: "none", end: "none" },
  summary: { shape: "thin", fill: "#000000", border: "#000000", progress: "#ffffff", start: "triangle", end: "triangle" },
  milestone: { shape: "solid", fill: "#ffffff", border: "#000000", progress: "#000000", start: "diamond", end: "none" },
};

/** #rgb or #rrggbb (any case) to #rrggbb; null when it isn't a colour. */
export function normaliseHex(text: string): string | null {
  const s = text.trim().replace(/^#?/, "#").toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  const m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(s);
  return m ? `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}` : null;
}

const SHAPE_KEYS = new Set(SHAPES.map((s) => s.key));
const END_KEYS = new Set(ENDS.map((s) => s.key));

/** Only fields that are valid survive; anything else (a bad colour, an unknown shape) is dropped, so a damaged saved value can't break the chart. */
export function clean(f: BarFormat | undefined | null): BarFormat {
  const out: BarFormat = {};
  if (!f || typeof f !== "object") return out;
  if (f.shape && SHAPE_KEYS.has(f.shape)) out.shape = f.shape;
  for (const k of ["fill", "border", "progress"] as const) { const c = typeof f[k] === "string" ? normaliseHex(f[k]!) : null; if (c) out[k] = c; }
  if (f.start && END_KEYS.has(f.start)) out.start = f.start;
  if (f.end && END_KEYS.has(f.end)) out.end = f.end;
  return out;
}

export function categoryOf(t: G.GTask, s: G.ScheduledTask, showCritical: boolean): BarCategory {
  if (s.summary) return "summary";
  if (t.milestone) return "milestone";
  return showCritical && s.critical ? "critical" : "task";
}

/** The bar as it will be drawn. A critical milestone takes the critical task's fill unless it has a colour of its own. */
export function resolve(t: G.GTask, s: G.ScheduledTask, styles: G.GProject["barStyles"], showCritical: boolean): Resolved {
  const cat = categoryOf(t, s, showCritical);
  const mine = clean(t.bar);
  const theirs = clean(styles?.[cat]);
  const base: Resolved = { ...USUAL[cat] };
  if (cat === "milestone" && showCritical && s.critical && !theirs.fill && !mine.fill) base.fill = clean(styles?.critical).fill ?? USUAL.critical.fill;
  return { ...base, ...theirs, ...mine };
}

export interface RowLike { task: G.GTask; seq: number }
type Patch = Partial<Record<keyof BarFormat, string | undefined>>;

/** A format with some fields set or (undefined) cleared; a value that isn't valid is ignored, so what was there stays. */
function patched(existing: BarFormat | undefined, patch: Patch): BarFormat {
  const next: Record<string, unknown> = { ...clean(existing) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) { delete next[k]; continue; }
    const ok = clean({ [k]: v } as BarFormat) as Record<string, unknown>;
    if (k in ok) next[k] = ok[k];
  }
  return next as BarFormat;
}

/** Set some of the selected tasks' format; a field set to undefined goes back to the project's style. A format that ends up empty is removed. */
export function setTaskBar(rows: RowLike[], uids: number[], patch: Patch): RowLike[] {
  return rows.map((r) => {
    if (!uids.includes(r.task.uid)) return r;
    const cleaned = patched(r.task.bar, patch);
    const { bar: _old, ...rest } = r.task;
    return { task: Object.keys(cleaned).length ? { ...rest, bar: cleaned } : (rest as G.GTask), seq: r.seq };
  });
}

export const resetTaskBar = (rows: RowLike[], uids: number[]): RowLike[] => rows.map((r) => {
  if (!uids.includes(r.task.uid) || !r.task.bar) return r;
  const { bar: _old, ...rest } = r.task;
  return { task: rest as G.GTask, seq: r.seq };
});

/** The project's styles with one kind's format changed (undefined fields go back to the usual); empty kinds are dropped. */
export function setStyle(styles: G.GProject["barStyles"], cat: BarCategory, patch: Patch): NonNullable<G.GProject["barStyles"]> {
  const out: NonNullable<G.GProject["barStyles"]> = { ...(styles ?? {}) };
  const cleaned = patched(styles?.[cat], patch);
  if (Object.keys(cleaned).length) out[cat] = cleaned; else delete out[cat];
  return out;
}
