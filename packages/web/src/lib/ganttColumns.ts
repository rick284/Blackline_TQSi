/**
 * The Gantt table's columns, sort and filter, with no screen in them. A column says how to show a task and how to order by it; a filter says
 * which tasks stay on show (a summary stays when something inside it does). Sorting and filtering change only what is shown: the project's
 * order is never touched, and "Sort by ID" puts the rows back as they are.
 */
import { gantt as G } from "@blackline/tender/core";
import { formatAssignments, type Totals } from "./ganttResources.js";
import { formatDate, formatDuration, formatLinks } from "./gantt.js";

export interface Row { task: G.GTask; s: G.ScheduledTask }

export interface Ctx {
  project: G.GProject;
  sched: G.ScheduleResult;
  totals: Map<number, Totals>;
  wc: G.WorkCalendar;
  /** Now, as minutes, for "late" */
  today: number;
  /** Programme task id -> its code, for the Programme Task column */
  progCodes?: Map<string, string>;
}

export interface ColDef {
  key: string;
  title: string;
  width: number;
  align?: "right" | "center";
  /** Typed into the table (summary tasks only take the ones marked `summaryToo`) */
  editable?: boolean;
  summaryToo?: boolean;
  text: (r: Row, c: Ctx) => string;
  /** What to order by: a number, or text; null sorts last */
  sort: (r: Row, c: Ctx) => number | string | null;
}

const mpd = (c: Ctx) => c.project.minutesPerDay;
const dur = (n: number, c: Ctx) => formatDuration(n, mpd(c));
const money = (n: number) => (n === 0 ? "" : `$${Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`);
const hours = (m: number) => (m === 0 ? "" : `${Math.round(m / 6) / 10} hrs`);
const base = (r: Row) => r.task.baseline;

export const COLUMNS: ColDef[] = [
  { key: "id", title: "ID", width: 40, align: "center", text: (r) => String(r.s.id), sort: (r) => r.s.id },
  { key: "wbs", title: "WBS", width: 64, text: (r) => r.s.wbs, sort: (r) => r.s.id },
  { key: "name", title: "Task Name", width: 250, editable: true, summaryToo: true, text: (r) => r.task.name, sort: (r) => r.task.name.toLowerCase() },
  { key: "duration", title: "Duration", width: 84, align: "right", editable: true, text: (r, c) => (r.task.milestone ? "0 days" : dur(r.s.durationMin, c)), sort: (r) => r.s.durationMin },
  { key: "start", title: "Start", width: 104, editable: true, text: (r) => formatDate(r.s.start), sort: (r) => r.s.startMin },
  { key: "finish", title: "Finish", width: 104, editable: true, text: (r) => formatDate(r.s.finish), sort: (r) => r.s.finishMin },
  { key: "pred", title: "Predecessors", width: 116, editable: true, text: (r, c) => formatLinks(r.task.links, (u) => c.sched.byUid.get(u)?.id, mpd(c)), sort: (r) => r.task.links.length },
  { key: "percent", title: "% Complete", width: 80, align: "right", editable: true, text: (r) => `${r.s.percent}%`, sort: (r) => r.s.percent },
  { key: "resources", title: "Resource Names", width: 150, editable: true, text: (r, c) => (r.s.summary ? "" : formatAssignments(r.task.uid, c.project)), sort: (r, c) => formatAssignments(r.task.uid, c.project).toLowerCase() || null },
  { key: "work", title: "Work", width: 80, align: "right", text: (r, c) => hours(c.totals.get(r.task.uid)?.workMin ?? 0), sort: (r, c) => c.totals.get(r.task.uid)?.workMin ?? 0 },
  { key: "cost", title: "Cost", width: 90, align: "right", text: (r, c) => money(c.totals.get(r.task.uid)?.cost ?? 0), sort: (r, c) => c.totals.get(r.task.uid)?.cost ?? 0 },
  { key: "totalSlack", title: "Total Slack", width: 90, align: "right", text: (r, c) => dur(r.s.totalSlackMin, c), sort: (r) => r.s.totalSlackMin },
  { key: "freeSlack", title: "Free Slack", width: 90, align: "right", text: (r, c) => (r.s.summary ? "" : dur(r.s.freeSlackMin, c)), sort: (r) => r.s.freeSlackMin },
  { key: "critical", title: "Critical", width: 64, align: "center", text: (r) => (r.s.critical ? "Yes" : "No"), sort: (r) => (r.s.critical ? 0 : 1) },
  { key: "constraint", title: "Constraint Type", width: 150, text: (r) => G.CONSTRAINT_NAMES[r.task.constraint], sort: (r) => G.CONSTRAINTS.indexOf(r.task.constraint) },
  { key: "constraintDate", title: "Constraint Date", width: 104, text: (r) => (r.task.constraintDate ? formatDate(r.task.constraintDate) : ""), sort: (r) => (r.task.constraintDate ? G.toMin(r.task.constraintDate) : null) },
  { key: "deadline", title: "Deadline", width: 104, editable: true, text: (r) => (r.task.deadline ? formatDate(r.task.deadline) : ""), sort: (r) => (r.task.deadline ? G.toMin(r.task.deadline) : null) },
  { key: "lateStart", title: "Late Start", width: 104, text: (r) => formatDate(r.s.lateStart), sort: (r) => G.toMin(r.s.lateStart) },
  { key: "lateFinish", title: "Late Finish", width: 104, text: (r) => formatDate(r.s.lateFinish), sort: (r) => G.toMin(r.s.lateFinish) },
  { key: "baselineStart", title: "Baseline Start", width: 104, text: (r) => (base(r) ? formatDate(base(r)!.start) : ""), sort: (r) => (base(r) ? G.toMin(base(r)!.start) : null) },
  { key: "baselineFinish", title: "Baseline Finish", width: 104, text: (r) => (base(r) ? formatDate(base(r)!.finish) : ""), sort: (r) => (base(r) ? G.toMin(base(r)!.finish) : null) },
  { key: "baselineDuration", title: "Baseline Duration", width: 104, align: "right", text: (r, c) => (base(r) ? dur(base(r)!.durationMin, c) : ""), sort: (r) => base(r)?.durationMin ?? null },
  { key: "startVariance", title: "Start Variance", width: 96, align: "right", text: (r, c) => (base(r) ? dur(c.wc.between(G.toMin(base(r)!.start), r.s.startMin), c) : ""), sort: (r, c) => (base(r) ? c.wc.between(G.toMin(base(r)!.start), r.s.startMin) : null) },
  { key: "finishVariance", title: "Finish Variance", width: 96, align: "right", text: (r, c) => (base(r) ? dur(c.wc.between(G.toMin(base(r)!.finish), r.s.finishMin), c) : ""), sort: (r, c) => (base(r) ? c.wc.between(G.toMin(base(r)!.finish), r.s.finishMin) : null) },
  { key: "calendar", title: "Task Calendar", width: 120, text: (r, c) => c.project.calendars.find((x) => x.uid === r.task.calendarUid)?.name ?? "", sort: (r, c) => c.project.calendars.find((x) => x.uid === r.task.calendarUid)?.name.toLowerCase() ?? null },
  { key: "progCode", title: "Programme Task", width: 110, text: (r, c) => (r.task.progId ? c.progCodes?.get(r.task.progId) ?? "" : ""), sort: (r, c) => (r.task.progId ? c.progCodes?.get(r.task.progId)?.toLowerCase() ?? null : null) },
  { key: "active", title: "Active", width: 60, align: "center", text: (r) => (r.task.active ? "Yes" : "No"), sort: (r) => (r.task.active ? 0 : 1) },
  { key: "notes", title: "Notes", width: 200, text: (r) => r.task.notes.replace(/\s+/g, " ").slice(0, 120), sort: (r) => r.task.notes.toLowerCase() || null },
];

export const COLUMN_BY_KEY = new Map(COLUMNS.map((c) => [c.key, c]));

/** What a cell starts with when opened for editing: the value as it would be typed, not as it is shown. */
export function editText(key: string, r: Row, c: Ctx): string {
  const col = COLUMN_BY_KEY.get(key)!;
  switch (key) {
    case "duration": return formatDuration(r.s.durationMin, mpd(c)).replace(/ days?$/, "d").replace(/ hrs?$/, "h");
    case "start": return r.s.start.slice(0, 10);
    case "finish": return r.s.finish.slice(0, 10);
    case "deadline": return r.task.deadline ? r.task.deadline.slice(0, 10) : "";
    case "percent": return String(r.s.percent);
    default: return col.text(r, c);
  }
}

/** Whether a cell can be typed into on this row. */
export const canEditCell = (key: string, r: Row) => { const col = COLUMN_BY_KEY.get(key); return !!col?.editable && (col.summaryToo || !r.s.summary); };
/** MS Project's Entry table, with Resource Names */
export const DEFAULT_COLUMNS = ["id", "name", "duration", "start", "finish", "pred", "percent", "resources"];

/** Keep only columns that exist, in order, with the name always present (a table with no task names makes no sense). */
export function cleanColumns(keys: unknown): string[] {
  if (!Array.isArray(keys)) return [...DEFAULT_COLUMNS]; // nothing saved, or something unreadable
  const unique = [...new Set(keys.filter((k): k is string => typeof k === "string" && COLUMN_BY_KEY.has(k)))];
  if (!unique.includes("name")) unique.splice(Math.min(1, unique.length), 0, "name");
  return unique;
}

export const toggleColumn = (keys: string[], key: string): string[] => (key === "name" ? keys : keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key]);
export function moveColumn(keys: string[], key: string, dir: -1 | 1): string[] {
  const i = keys.indexOf(key), j = i + dir;
  if (i < 0 || j < 0 || j >= keys.length) return keys;
  const out = [...keys];
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
}

// ---- filters -----------------------------------------------------------------------------------------------------------------------------
export type FilterKind = "all" | "critical" | "milestones" | "summary" | "incomplete" | "complete" | "late" | "slipping" | "inactive" | "resource" | "dates";
export const FILTERS: { kind: FilterKind; label: string }[] = [
  { kind: "all", label: "All Tasks" }, { kind: "critical", label: "Critical" }, { kind: "milestones", label: "Milestones" }, { kind: "summary", label: "Summary Tasks" },
  { kind: "incomplete", label: "Incomplete Tasks" }, { kind: "complete", label: "Completed Tasks" }, { kind: "late", label: "Late Tasks" }, { kind: "slipping", label: "Slipping Tasks" },
  { kind: "inactive", label: "Inactive Tasks" }, { kind: "resource", label: "Using Resource" }, { kind: "dates", label: "Date Range" },
];

export interface FilterSpec { kind: FilterKind; resourceUid?: number; from?: string; to?: string; text: string }
export const NO_FILTER: FilterSpec = { kind: "all", text: "" };
export const isFiltering = (f: FilterSpec) => f.kind !== "all" || f.text.trim() !== "";

export function matches(r: Row, f: FilterSpec, c: Ctx): boolean {
  const { task: t, s } = r;
  const leaf = !s.summary;
  let ok: boolean;
  switch (f.kind) {
    case "all": ok = true; break;
    case "critical": ok = leaf && s.critical; break;
    case "milestones": ok = t.milestone && leaf; break;
    case "summary": ok = s.summary; break;
    case "incomplete": ok = leaf && s.percent < 100; break;
    case "complete": ok = leaf && s.percent >= 100; break;
    case "late": ok = leaf && s.percent < 100 && s.finishMin < (c.project.statusDate ? G.toMin(c.project.statusDate) : c.today); break;
    case "slipping": ok = leaf && !!t.baseline && s.finishMin > G.toMin(t.baseline.finish); break;
    case "inactive": ok = !t.active; break;
    case "resource": ok = f.resourceUid !== undefined && c.project.assignments.some((a) => a.taskUid === t.uid && a.resourceUid === f.resourceUid); break;
    case "dates": {
      const from = f.from ? G.toMin(f.from) : -Infinity, to = f.to ? G.toMin(f.to) + 1440 : Infinity;
      ok = s.finishMin >= from && s.startMin < to;
      break;
    }
  }
  if (!ok) return false;
  const q = f.text.trim().toLowerCase();
  if (!q) return true;
  return [t.name, formatAssignments(t.uid, c.project), t.notes, s.wbs].some((x) => x.toLowerCase().includes(q));
}

// ---- sort --------------------------------------------------------------------------------------------------------------------------------
export interface SortSpec { key: string; dir: "asc" | "desc" }

function compare(a: number | string | null, b: number | string | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1; // blanks last, whichever way round
  if (b === null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), "en", { numeric: true });
}

/**
 * The rows to show, in order. Filter first (a summary is kept when anything inside it is), then sort within each summary (so the outline is
 * kept, as in MS Project), then hide what is inside collapsed summaries. Rows come in project order.
 */
export function arrange(rows: Row[], opts: { filter: FilterSpec; sort: SortSpec | null; collapsed: Set<number> }, c: Ctx): { rows: Row[]; filtered: boolean; sorted: boolean } {
  const byUid = new Map(rows.map((r) => [r.task.uid, r]));
  const filtered = isFiltering(opts.filter);
  let keep: Set<number> | null = null;
  if (filtered) {
    keep = new Set();
    for (const r of rows) if (matches(r, opts.filter, c)) { for (let u: number | null = r.task.uid; u !== null && !keep.has(u); u = byUid.get(u)?.s.parentUid ?? null) keep.add(u); }
  }
  const col = opts.sort ? COLUMN_BY_KEY.get(opts.sort.key) : undefined;
  const out: Row[] = [];
  const walk = (list: Row[]) => {
    let items = keep ? list.filter((r) => keep!.has(r.task.uid)) : list;
    if (col && opts.sort) {
      const sign = opts.sort.dir === "asc" ? 1 : -1;
      items = [...items].sort((x, y) => {
        const a = col.sort(x, c), b = col.sort(y, c);
        return (a === null || b === null ? compare(a, b) : sign * compare(a, b)) || x.s.id - y.s.id;
      });
    }
    for (const r of items) {
      out.push(r);
      if (r.s.summary && !opts.collapsed.has(r.task.uid)) walk(r.s.childUids.map((u) => byUid.get(u)!).filter(Boolean));
    }
  };
  walk(rows.filter((r) => r.s.parentUid === null));
  return { rows: out, filtered, sorted: !!col };
}
