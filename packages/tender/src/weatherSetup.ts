/**
 * A tender's live weather-tool setup (stored with its inputs) and the bridge to `weatherTool`.
 *
 * An activity's exposed labour/plant is, unless typed in, the cost of the build-up rows in its QS items that are tagged
 * Weather Exposed (Labour rows -> labour, Plant rows -> plant). Strings keep decimals exact in the saved JSON.
 */
import { D, type Dec, ZERO } from "@blackline/engine";
import type { BuildUpRow, RowResult } from "./models.js";
import { ENGINE_FROM, ENGINE_TO, OVERRIDE_FIELDS, runTool, stations, taskNames, type OverrideField, type ToolResult } from "./weatherTool.js";

export const SETUP_FIELDS = ["station", "start", "working_days_per_week", "baseline_wd", "local_factor", "local_basis", "wind_override", "include_wind"] as const;
export const ACTIVITY_FIELDS = ["task", "start", "finish", "critical", "qs_codes", "labour", "plant", "note", ...OVERRIDE_FIELDS.map((k) => `ov_${k}`)];
export const MAX_ACTIVITIES = 30; // the workbook has 30 activity rows

export class SetupError extends Error {}

export interface WeatherActivityInput {
  id: string;
  task: string;
  start: string;
  finish: string;
  critical: boolean;
  qs_codes: string[];
  labour: string | null;
  plant: string | null;
  overrides: Partial<Record<OverrideField, string>>;
  note: string;
}

export interface WeatherSetup {
  station: string;
  start: string;
  working_days_per_week: number;
  baseline_wd: number;
  local_factor: string;
  local_basis: string;
  wind_override: string | null;
  include_wind: boolean;
  activities: WeatherActivityInput[];
}

const fmtDate = (s: string) => {
  const t = new Date(`${s}T00:00:00Z`);
  return `${String(t.getUTCDate()).padStart(2, "0")}-${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][t.getUTCMonth()]}-${t.getUTCFullYear()}`;
};

function dateField(v: unknown, what: string, required = true): string {
  const s = v === null || v === undefined ? "" : String(v).trim();
  if (!s) {
    if (required) throw new SetupError(`${what} needs a date.`);
    return "";
  }
  const day = s.slice(0, 10);
  const t = new Date(`${day}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== day)
    throw new SetupError(`${what} isn't a valid date (use year-month-day).`);
  if (day < ENGINE_FROM || day > ENGINE_TO)
    throw new SetupError(`${what} must be between ${fmtDate(ENGINE_FROM)} and ${fmtDate(ENGINE_TO)} (the range the climate engine covers).`);
  return day;
}

function numField(v: unknown, what: string, o: { lo?: Dec; hi?: Dec; nullable?: boolean } = {}): string | null {
  const lo = o.lo ?? ZERO;
  if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) {
    if (o.nullable) return null;
    throw new SetupError(`${what} needs a number.`);
  }
  let x: Dec;
  try {
    x = new D(String(v).trim());
  } catch {
    throw new SetupError(`${what} needs a number.`);
  }
  if (!x.isFinite() || x.lt(lo) || (o.hi !== undefined && x.gt(o.hi))) throw new SetupError(`${what} must be between ${lo} and ${o.hi !== undefined ? o.hi : "a large number"}.`);
  return x.toString();
}

const asBool = (v: unknown) => (typeof v === "boolean" ? v : ["yes", "true", "1"].includes(String(v).trim().toLowerCase()));
const int = (s: string | null) => Number((s as string).split(".")[0]);

export function setSetupField(s: WeatherSetup, field: string, value: unknown): void {
  switch (field) {
    case "station": {
      const v = String(value ?? "").trim();
      if (!stations().includes(v)) throw new SetupError("Choose a weather station from the list.");
      s.station = v;
      break;
    }
    case "start":
      s.start = dateField(value, "Project start");
      break;
    case "working_days_per_week":
      s.working_days_per_week = int(numField(value, "Working days per week", { lo: new D(1), hi: new D(7) }));
      break;
    case "baseline_wd":
      s.baseline_wd = int(numField(value, "Baseline working days", { lo: ZERO, hi: new D(3000) }));
      break;
    case "local_factor":
      s.local_factor = numField(value, "Local wet-day factor", { lo: new D("0.1"), hi: new D(3) })!;
      break;
    case "local_basis":
      s.local_basis = String(value ?? "").trim().slice(0, 500);
      break;
    case "wind_override":
      s.wind_override = numField(value, "Wind probability", { lo: ZERO, hi: new D(1), nullable: true });
      break;
    case "include_wind":
      s.include_wind = asBool(value);
      break;
    default:
      throw new SetupError(`'${field}' can't be edited on the weather setup.`);
  }
}

export function newSetup(station: string, start: unknown, workingDaysPerWeek: unknown = 5, baselineWd: unknown = 0): WeatherSetup {
  const s: WeatherSetup = { station: "", start: "", working_days_per_week: 5, baseline_wd: 0, local_factor: "1", local_basis: "", wind_override: null, include_wind: false, activities: [] };
  for (const [k, v] of [["station", station], ["start", start], ["working_days_per_week", workingDaysPerWeek], ["baseline_wd", baselineWd]] as const) setSetupField(s, k, v);
  return s;
}

export function setActivityField(a: WeatherActivityInput, field: string, value: unknown): void {
  if (field === "task") {
    const v = String(value ?? "").trim();
    if (!taskNames().includes(v)) throw new SetupError("Choose a task from the weather task library.");
    a.task = v;
  } else if (field === "start" || field === "finish") a[field] = dateField(value, `Activity ${field}`);
  else if (field === "critical") a.critical = asBool(value);
  else if (field === "qs_codes") {
    const list = typeof value === "string" ? value.split(/[,\s]+/).filter(Boolean) : value;
    if (!Array.isArray(list) || list.some((x) => typeof x !== "string")) throw new SetupError("QS items must be a list of codes.");
    a.qs_codes = (list as string[]).map((x) => x.trim().toUpperCase()).slice(0, 40);
  } else if (field === "labour" || field === "plant") a[field] = numField(value, `Exposed ${field}`, { nullable: true, hi: new D("1e12") });
  else if (field === "note") a.note = String(value ?? "").trim().slice(0, 300);
  else if (field.startsWith("ov_") && (OVERRIDE_FIELDS as readonly string[]).includes(field.slice(3))) {
    const name = field.slice(3) as OverrideField;
    a.overrides = { ...a.overrides };
    const v = numField(value, name.replace(/_/g, " "), { nullable: true, hi: new D(1) });
    if (v === null) delete a.overrides[name];
    else a.overrides[name] = v;
  } else throw new SetupError(`'${field}' can't be edited on a weather activity.`);
}

export function checkActivity(a: WeatherActivityInput): void {
  if (!a.task) throw new SetupError("Choose a task from the weather task library.");
  if (!a.start || !a.finish) throw new SetupError("An activity needs a start and a finish date.");
  if (a.finish < a.start) throw new SetupError("An activity can't finish before it starts.");
}

export function buildActivity(id: string, v: Record<string, unknown>): WeatherActivityInput {
  const a: WeatherActivityInput = { id, task: "", start: "", finish: "", critical: false, qs_codes: [], labour: null, plant: null, overrides: {}, note: "" };
  for (const k of ["task", "start", "finish", "critical", "qs_codes", "labour", "plant", "note"]) if (k in v) setActivityField(a, k, v[k]);
  for (const k of OVERRIDE_FIELDS) if (v[`ov_${k}`] !== undefined && v[`ov_${k}`] !== null && v[`ov_${k}`] !== "") setActivityField(a, `ov_${k}`, v[`ov_${k}`]);
  checkActivity(a);
  return a;
}

/** qs_code -> [exposed labour, exposed plant] from the weather-exposed rows. */
export function exposedByQs(buildup: BuildUpRow[], results: RowResult[]): Map<string, [Dec, Dec]> {
  const out = new Map<string, [Dec, Dec]>();
  buildup.forEach((row, i) => {
    if (row.weatherExposed !== "Yes") return;
    const e = out.get(row.qsCode) ?? [ZERO, ZERO];
    if (row.resourceType === "Labour") e[0] = e[0].plus(results[i]!.cost);
    else if (row.resourceType === "Plant") e[1] = e[1].plus(results[i]!.cost);
    out.set(row.qsCode, e);
  });
  return out;
}

const money = (x: Dec) => x.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** Returns the tool result, the per-activity labour/plant used, and warnings. */
export function runSetup(
  setup: WeatherSetup,
  exposed: Map<string, [Dec, Dec]>,
  dailyPrelims: Dec,
  weeklyHire: Dec,
  recovery: Dec,
): { result: ToolResult; used: { labour: Dec; plant: Dec }[]; warnings: string[] } {
  const warnings: string[] = [];
  const used: { labour: Dec; plant: Dec }[] = [];
  const linked = new Set<string>();
  const get = (c: string): [Dec, Dec] => exposed.get(c) ?? [ZERO, ZERO];
  const acts = setup.activities.map((a) => {
    let lab = a.labour !== null ? new D(a.labour) : null;
    let pla = a.plant !== null ? new D(a.plant) : null;
    if (lab === null || pla === null) {
      const autoL = a.qs_codes.reduce((t, c) => t.plus(get(c)[0]), ZERO);
      const autoP = a.qs_codes.reduce((t, c) => t.plus(get(c)[1]), ZERO);
      lab = lab === null ? autoL : lab;
      pla = pla === null ? autoP : pla;
      a.qs_codes.forEach((c) => linked.add(c));
    }
    if (lab.plus(pla).isZero())
      warnings.push(`${a.task} (${a.start} to ${a.finish}) has no weather-exposed labour or plant, so it adds no direct cost` + (a.critical ? " (it still counts for delay if it is on the critical path)." : "."));
    used.push({ labour: lab, plant: pla });
    return { task: a.task, start: a.start, finish: a.finish, critical: a.critical, labour: lab, plant: pla, overrides: a.overrides, note: a.note };
  });
  const allExposed = [...exposed.values()].reduce((t, [l, p]) => t.plus(l).plus(p), ZERO);
  const linkedSum = [...linked].reduce((t, c) => t.plus(get(c)[0]).plus(get(c)[1]), ZERO);
  const gap = allExposed.minus(linkedSum);
  if (gap.gt("0.005")) warnings.push(`$${money(gap)} of weather-exposed labour and plant is not linked to any weather activity, so it carries no weather allowance.`);
  const result = runTool(
    {
      station: setup.station, workingDaysPerWeek: setup.working_days_per_week, localFactor: setup.local_factor, windOverride: setup.wind_override,
      dailyPrelims, weeklyHire, recovery,
    },
    acts,
    setup.include_wind,
  );
  return { result, used, warnings };
}
