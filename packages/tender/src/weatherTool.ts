/**
 * Port of NZ_Weather_Risk_Estimating_Tool_Rev2 ("Activity Allowances" method): pure and deterministic.
 * Climate normals: NIWA / Earth Sciences New Zealand, 1991-2020, Creative Commons Attribution 4.0 (keep attribution).
 * Task factors: company estimating judgement (AMBER until calibrated). See src/data/weather_rev2.json.
 *
 * For each weather-exposed activity (a task from the Task Library, a date window, exposed labour + plant cost):
 *
 *   wet-day probability   = average NIWA daily wet-day probability over the activity's WORKDAYS
 *   adjusted probability  = min(1, wet-day probability x local wet-day factor)
 *   wind probability      = override, else average of the daily wind proxy (Auckland only, AMBER) over the workdays
 *   rain impact           = adjusted prob x rain exposure x rain productivity loss x non-recoverable share
 *   wet-ground carryover  = adjusted prob x carryover equivalent days x non-recoverable share
 *   wind impact           = wind prob x wind sensitivity x wind productivity loss x non-recoverable share
 *   combined impact       = min(1, rain + carryover + wind)
 *   direct allowance      = (labour + plant) x combined impact
 *   equivalent lost WD    = workdays x combined impact; critical-path delay = that, ONLY if the activity is on the critical path
 *
 * Project totals: direct allowance, critical-path delay (WD; never summed across concurrent non-critical activities),
 * time-related preliminaries = delay x daily preliminaries, additional billed hire weeks = ROUNDUP(delay / days-per-week),
 * hire = weeks x weekly hire, plus any project-specific recovery allowance.
 *
 * includeWind=false (the platform default: wind is separate and AMBER) computes the totals without the wind term and
 * reports the wind sensitivity separately; includeWind=true reproduces the workbook's own totals exactly. Public holidays
 * and shutdowns are not modelled (same as the workbook).
 */
import { D, type Dec, ZERO } from "@blackline/engine";
import data from "./data/weather_rev2.json" with { type: "json" };
import { d, type Num } from "./models.js";

const ONE = new D(1);
export const ENGINE_FROM = "2025-01-01";
export const ENGINE_TO = "2040-12-31";
export const OVERRIDE_FIELDS = ["rain_exposure", "rain_loss", "carryover", "wind_sensitivity", "wind_loss", "nonrecoverable"] as const;
export type OverrideField = (typeof OVERRIDE_FIELDS)[number];

type RawTask = { name: string; category: string } & Record<OverrideField, string>;
type TaskFactors = Record<OverrideField, Dec>;
const raw = data as unknown as {
  stations: { name: string }[];
  climate: Record<string, { month: number; wet_days: string; calendar_days: string }[]>;
  wind_proxy: Record<string, { month: number; season_share: string; annual_gust_days: string }[]>;
  tasks: RawTask[];
};

export const toolData = () => data;
export const stations = () => raw.stations.map((s) => s.name);
export const taskNames = () => raw.tasks.map((t) => t.name);

const tasks = new Map<string, TaskFactors>(
  raw.tasks.map((t) => [t.name, Object.fromEntries(OVERRIDE_FIELDS.map((k) => [k, new D(t[k])])) as TaskFactors]),
);

const monthlyCache = new Map<string, { wet: Dec[]; wind: Dec[] }>();
/** Daily wet-day probability by month 1..12, and daily wind-proxy probability by month 1..12, for a station. */
function monthly(station: string) {
  const hit = monthlyCache.get(station);
  if (hit) return hit;
  const clim = raw.climate[station];
  if (!clim) throw new Error(`Unknown weather station '${station}'.`);
  const cal = new Map(clim.map((m) => [m.month, new D(m.calendar_days)]));
  const wet = clim.map((m) => (cal.get(m.month)!.isZero() ? ZERO : new D(m.wet_days).div(cal.get(m.month)!)));
  const wp = raw.wind_proxy[station];
  let wind: Dec[];
  if (!wp) wind = Array.from({ length: 12 }, () => ZERO);
  else {
    const by = new Map(wp.map((m) => [m.month, m]));
    const base = [1, 4, 7, 10].reduce((t, mm) => t.plus(by.get(mm)!.season_share), ZERO); // one month per season, as in the workbook
    wind = Array.from({ length: 12 }, (_, i) => {
      const mm = i + 1;
      return new D(by.get(mm)!.annual_gust_days).times(new D(by.get(mm)!.season_share).div(base)).div(3).div(cal.get(mm)!);
    });
  }
  const out = { wet, wind };
  monthlyCache.set(station, out);
  return out;
}

export interface ToolSettings {
  station: string;
  workingDaysPerWeek?: number;
  localFactor?: Num;
  /** Daily wind-event probability; replaces the proxy */
  windOverride?: Num | null;
  /** Supervisor rate x hours per day */
  dailyPrelims?: Num;
  /** Weekly billed hire + facilities */
  weeklyHire?: Num;
  /** Project-specific recovery / remediation allowance */
  recovery?: Num;
}

export interface WeatherActivity {
  task: string;
  /** ISO dates, year-month-day */
  start: string;
  finish: string;
  critical?: boolean;
  labour?: Num;
  plant?: Num;
  overrides?: Partial<Record<OverrideField, Num>>;
  note?: string;
}

export interface ActivityResult {
  task: string;
  workdays: number;
  wetProbability: Dec;
  adjustedWetProbability: Dec;
  windProbability: Dec;
  rainImpact: Dec;
  carryoverImpact: Dec;
  windImpact: Dec;
  /** As the workbook (includes wind) */
  combinedImpact: Dec;
  combinedImpactExclWind: Dec;
  directAllowance: Dec;
  directAllowanceExclWind: Dec;
  lostWd: Dec;
  lostWdExclWind: Dec;
  status: string;
}

export interface ToolResult {
  activities: ActivityResult[];
  includeWind: boolean;
  exposedPool: Dec;
  /** On the chosen basis */
  directAllowance: Dec;
  /** Extra direct cost if wind were included (always reported) */
  windSensitivity: Dec;
  criticalPathDelayWd: Dec;
  additionalBilledWeeks: number;
  preliminariesAllowance: Dec;
  hireAllowance: Dec;
  recovery: Dec;
  totalAllowance: Dec;
  redFlags: string[];
  confidence: string;
}

const dayMs = 86400000;
const parse = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00Z`).getTime();
const isoWeekday = (t: number) => new Date(t).getUTCDay() || 7;
const eff = (task: TaskFactors, overrides: WeatherActivity["overrides"], key: OverrideField): Dec => {
  const v = overrides?.[key];
  return v === null || v === undefined || v === "" ? task[key] : d(v);
};
const fmtDate = (s: string) => {
  const t = new Date(`${s}T00:00:00Z`);
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][t.getUTCMonth()];
  return `${String(t.getUTCDate()).padStart(2, "0")}-${mon}-${t.getUTCFullYear()}`;
};

function window(station: string, wpw: number, start: string, finish: string, windOverride: Dec | null) {
  const { wet: wetM, wind: windM } = monthly(station);
  let n = 0;
  let wet = ZERO, wind = ZERO;
  for (let t = parse(start); t <= parse(finish); t += dayMs) {
    if (isoWeekday(t) <= wpw) {
      n++;
      const m = new Date(t).getUTCMonth();
      wet = wet.plus(wetM[m]!);
      wind = wind.plus(windM[m]!);
    }
  }
  if (n === 0) return { n: 0, wet: null, wind: null };
  return { n, wet: wet.div(n), wind: windOverride !== null ? windOverride : wind.div(n) };
}

export function runTool(settings: ToolSettings, activities: WeatherActivity[], includeWind = false): ToolResult {
  const wpw = settings.workingDaysPerWeek ?? 5;
  const localFactor = d(settings.localFactor ?? 1);
  if (wpw < 1 || wpw > 7) throw new Error("Working days per week must be between 1 and 7.");
  if (localFactor.lt(0)) throw new Error("Local wet-day factor can't be negative.");
  const windOverride = settings.windOverride === null || settings.windOverride === undefined ? null : d(settings.windOverride);

  const res: ActivityResult[] = [];
  const flags: string[] = [];
  for (const a of activities) {
    const t = tasks.get(a.task);
    if (!t) throw new Error(`'${a.task}' is not in the task library.`);
    const badDate = parse(a.start) < parse(ENGINE_FROM) || parse(a.finish) > parse(ENGINE_TO) || parse(a.finish) < parse(a.start);
    const w = badDate ? { n: 0, wet: null, wind: null } : window(settings.station, wpw, a.start, a.finish, windOverride);
    if (w.n === 0) {
      flags.push(`${a.task}: dates outside the engine range (${fmtDate(ENGINE_FROM)} to ${fmtDate(ENGINE_TO)}) or no working days in the window`);
      res.push({
        task: a.task, workdays: 0, wetProbability: ZERO, adjustedWetProbability: ZERO, windProbability: ZERO, rainImpact: ZERO, carryoverImpact: ZERO, windImpact: ZERO,
        combinedImpact: ZERO, combinedImpactExclWind: ZERO, directAllowance: ZERO, directAllowanceExclWind: ZERO, lostWd: ZERO, lostWdExclWind: ZERO, status: "RED - date input",
      });
      continue;
    }
    const wet = w.wet!, wind = w.wind!;
    const adj = D.min(ONE, wet.times(localFactor));
    const e = (k: OverrideField) => eff(t, a.overrides, k);
    const rain = adj.times(e("rain_exposure")).times(e("rain_loss")).times(e("nonrecoverable"));
    const carry = adj.times(e("carryover")).times(e("nonrecoverable"));
    const wnd = wind.times(e("wind_sensitivity")).times(e("wind_loss")).times(e("nonrecoverable"));
    const comb = D.min(ONE, rain.plus(carry).plus(wnd));
    const combX = D.min(ONE, rain.plus(carry));
    const pool = d(a.labour).plus(d(a.plant));
    let status: string;
    if (e("wind_sensitivity").gte("0.2") && wind.isZero()) {
      status = "RED - wind input";
      flags.push(`${a.task}: wind-sensitive task with no wind data for ${settings.station}; enter a sourced wind probability or exclude wind`);
    } else if (!localFactor.eq(1)) status = "AMBER - local factor requires basis";
    else status = "AMBER - task factors uncalibrated";
    res.push({
      task: a.task, workdays: w.n, wetProbability: wet, adjustedWetProbability: adj, windProbability: wind, rainImpact: rain, carryoverImpact: carry, windImpact: wnd,
      combinedImpact: comb, combinedImpactExclWind: combX, directAllowance: pool.times(comb), directAllowanceExclWind: pool.times(combX),
      lostWd: comb.times(w.n), lostWdExclWind: combX.times(w.n), status,
    });
  }

  const sum = (xs: Dec[]) => xs.reduce((t, x) => t.plus(x), ZERO);
  const poolTotal = sum(activities.map((a) => d(a.labour).plus(d(a.plant))));
  const crit = res.filter((_, i) => activities[i]!.critical);
  const directWind = sum(res.map((r) => r.directAllowance));
  const directX = sum(res.map((r) => r.directAllowanceExclWind));
  const delayWind = sum(crit.map((r) => r.lostWd));
  const delayX = sum(crit.map((r) => r.lostWdExclWind));
  const [direct, delay] = includeWind ? [directWind, delayWind] : [directX, delayX];
  const weeks = delay.gt(0) ? delay.div(wpw).ceil().toNumber() : 0;
  const prelims = delay.times(d(settings.dailyPrelims));
  const hire = d(settings.weeklyHire).times(weeks);
  const rec = d(settings.recovery);
  const confidence = flags.length ? "RED - resolve flagged inputs before issue" : activities.length === 0 ? "INCOMPLETE - no activities" : "AMBER - NIWA data GREEN; task factors uncalibrated";
  return {
    activities: res, includeWind, exposedPool: poolTotal, directAllowance: direct, windSensitivity: directWind.minus(directX), criticalPathDelayWd: delay,
    additionalBilledWeeks: weeks, preliminariesAllowance: prelims, hireAllowance: hire, recovery: rec, totalAllowance: direct.plus(prelims).plus(hire).plus(rec),
    redFlags: flags, confidence,
  };
}
