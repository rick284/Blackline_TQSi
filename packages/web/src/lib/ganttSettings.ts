/**
 * How a person likes the Gantt shown: columns, sort, filter, zoom, how wide the table is. Kept on this computer (not in the project: it is
 * the person's view, not the plan), read defensively so a bad or old saved value just falls back to the default.
 */
import { DEFAULT_COLUMNS, FILTERS, NO_FILTER, cleanColumns, COLUMN_BY_KEY, type FilterSpec, type SortSpec } from "./ganttColumns.js";
import { ZOOMS, type Zoom } from "./ganttView.js";

export type View = "chart" | "resources" | "calendars";

export interface GanttSettings {
  columns: string[];
  sort: SortSpec | null;
  filter: FilterSpec;
  zoom: Zoom;
  /** Width of the table beside the chart, in px */
  leftW: number;
  showCritical: boolean;
  showBaseline: boolean;
}

export const MIN_LEFT = 240;
export const MAX_LEFT = 1400;

export const defaultSettings = (): GanttSettings => ({
  columns: [...DEFAULT_COLUMNS], sort: null, filter: { ...NO_FILTER }, zoom: "weeks", leftW: 560, showCritical: true, showBaseline: true,
});

export const settingsKey = (jobId: string) => `bl:gantt:${jobId}`;

const date = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 19) : undefined);

export function parseSettings(text: string | null): GanttSettings {
  const d = defaultSettings();
  if (!text) return d;
  let raw: any;
  try { raw = JSON.parse(text); } catch { return d; }
  if (!raw || typeof raw !== "object") return d;
  const f = raw.filter && typeof raw.filter === "object" ? raw.filter : {};
  const kind = FILTERS.some((x) => x.kind === f.kind) ? f.kind : "all";
  return {
    columns: cleanColumns(raw.columns),
    sort: raw.sort && COLUMN_BY_KEY.has(raw.sort.key) && (raw.sort.dir === "asc" || raw.sort.dir === "desc") ? { key: raw.sort.key, dir: raw.sort.dir } : null,
    filter: { kind, text: typeof f.text === "string" ? f.text.slice(0, 200) : "", resourceUid: Number.isInteger(f.resourceUid) ? f.resourceUid : undefined, from: date(f.from), to: date(f.to) },
    zoom: ZOOMS.includes(raw.zoom) ? raw.zoom : d.zoom,
    leftW: typeof raw.leftW === "number" && Number.isFinite(raw.leftW) ? Math.min(MAX_LEFT, Math.max(MIN_LEFT, Math.round(raw.leftW))) : d.leftW,
    showCritical: typeof raw.showCritical === "boolean" ? raw.showCritical : d.showCritical,
    showBaseline: typeof raw.showBaseline === "boolean" ? raw.showBaseline : d.showBaseline,
  };
}

/** The next sort when a column heading is clicked: ascending, then descending, then none (project order). */
export function nextSort(cur: SortSpec | null, key: string): SortSpec | null {
  if (!cur || cur.key !== key) return { key, dir: "asc" };
  return cur.dir === "asc" ? { key, dir: "desc" } : null;
}
