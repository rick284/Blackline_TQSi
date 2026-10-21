/**
 * Tender programme: working-day durations, predecessors and the critical path (finish-to-start, no lags).
 *
 * A task's duration is its override when one is entered, otherwise the QS item's derived duration: the slowest linked
 * resource row, in hours, divided by the working day (default 8) and rounded UP, exactly the Master Estimate Workbook's
 * Programme Export rule. A hammock task (preliminaries) runs across the whole job; it is shown on the programme but is
 * not on the critical path. Dates count Monday-to-Friday (or the stated days per week); public holidays and shutdowns
 * are not modelled.
 */
import { D, type Dec } from "@blackline/engine";

const CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$/;
export const TASK_FIELDS = ["code", "name", "override_days", "predecessors", "hammock", "basis", "note"] as const;

export class ProgrammeError extends Error {}

export interface ProgrammeTask {
  id: string;
  code: string;
  name: string;
  /** "" for a control task with no cost */
  qs_code: string;
  override_days: string | null;
  predecessors: string[];
  hammock: boolean;
  basis: string;
  note: string;
}

export interface Programme {
  start: string;
  days_per_week: number;
  hours_per_day: number;
  tasks: ProgrammeTask[];
}

export function derivedDays(hours: Dec | null | undefined, hoursPerDay = 8): number | null {
  if (hours === null || hours === undefined || hours.lte(0)) return null;
  return hours.div(hoursPerDay).ceil().toNumber();
}

const isoWeekday = (d: Date) => d.getUTCDay() || 7;
const parseDate = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400000);

/** Date of the index-th (0-based) working day counting from `start` (a non-working start rolls forward). */
export function workingDate(start: Date, index: number, daysPerWeek = 5): Date {
  let d = start;
  while (isoWeekday(d) > daysPerWeek) d = addDays(d, 1);
  let n = 0;
  while (n < index) {
    d = addDays(d, 1);
    if (isoWeekday(d) <= daysPerWeek) n++;
  }
  return d;
}

export const newProgramme = (start = "", daysPerWeek = 5, hoursPerDay = 8): Programme => ({ start, days_per_week: daysPerWeek, hours_per_day: hoursPerDay, tasks: [] });

export function setConfig(p: Programme, field: string, value: unknown): void {
  if (field === "start") {
    let v = String(value ?? "").trim();
    if (v) {
      if (!/^\d{4}-\d{2}-\d{2}/.test(v) || Number.isNaN(parseDate(v).getTime()) || iso(parseDate(v)) !== v.slice(0, 10))
        throw new ProgrammeError("The programme start isn't a valid date (use year-month-day).");
      v = v.slice(0, 10);
    }
    p.start = v;
  } else if (field === "days_per_week" || field === "hours_per_day") {
    const [lo, hi] = field === "days_per_week" ? [1, 7] : [1, 24];
    const s = String(value).trim();
    if (!/^[+-]?\d+$/.test(s)) throw new ProgrammeError("That needs a whole number.");
    const n = Number(s);
    if (n < lo || n > hi) throw new ProgrammeError(`${field.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())} must be between ${lo} and ${hi}.`);
    p[field] = n;
  } else throw new ProgrammeError(`'${field}' can't be edited on the programme.`);
}

export function setTaskField(t: ProgrammeTask, field: string, value: unknown, allTasks: ProgrammeTask[]): void {
  if (!(TASK_FIELDS as readonly string[]).includes(field)) throw new ProgrammeError(`'${field}' can't be edited on a programme task.`);
  if (field === "code") {
    const v = String(value ?? "").trim();
    if (!CODE.test(v)) throw new ProgrammeError("A task code is letters, numbers and dashes, for example PRG-RF01.");
    if (allTasks.some((x) => x !== t && x.code === v)) throw new ProgrammeError(`Task code ${v} is already used.`);
    t.code = v;
  } else if (field === "override_days") {
    const s = value === null || value === undefined ? "" : String(value).trim();
    if (s === "") t.override_days = null;
    else {
      let n: Dec;
      try {
        n = new D(s);
        if (!n.isFinite()) throw new Error();
      } catch {
        throw new ProgrammeError("Days needs a whole number.");
      }
      if (!n.isInteger() || n.lt(0) || n.gt(3000)) throw new ProgrammeError("Days needs a whole number from 0 to 3000.");
      t.override_days = n.toFixed(0);
    }
  } else if (field === "predecessors") {
    const codes = typeof value === "string" ? value.split(/[,;\s]+/).filter(Boolean) : ((value as unknown[]) ?? []).map(String);
    if (codes.includes(t.code)) throw new ProgrammeError("A task can't follow itself.");
    t.predecessors = [...new Set(codes)];
  } else if (field === "hammock") {
    t.hammock = typeof value === "boolean" ? value : ["yes", "true", "1"].includes(String(value).trim().toLowerCase());
  } else {
    const v = value === null || value === undefined ? "" : String(value).trim();
    if (field === "name" && !v) throw new ProgrammeError("A task needs a name.");
    if (v.length > (field === "name" ? 200 : 500)) throw new ProgrammeError(`${field.charAt(0).toUpperCase() + field.slice(1)} is too long.`);
    (t as unknown as Record<string, unknown>)[field] = v;
  }
}

export function buildTask(taskId: string, v: Record<string, unknown>, allTasks: ProgrammeTask[]): ProgrammeTask {
  const t: ProgrammeTask = { id: taskId, code: "", name: "", qs_code: String(v.qs_code ?? ""), override_days: null, predecessors: [], hammock: false, basis: "", note: "" };
  for (const f of TASK_FIELDS) if (v[f] !== undefined && v[f] !== null && v[f] !== "") setTaskField(t, f, v[f], allTasks);
  if (!t.code) throw new ProgrammeError("A task needs a code.");
  if (!t.name) throw new ProgrammeError("A task needs a name.");
  if (allTasks.some((x) => x.code === t.code)) throw new ProgrammeError(`Task code ${t.code} is already used.`);
  return t;
}

export interface QsInfo { section?: string; description?: string; amount?: number | null }

export interface ProgrammeTaskResult {
  id: string; code: string; name: string; qs_code: string; section: string; amount: number | null | undefined; duration: number;
  derived: number | null; override: string | null; predecessors: string[]; hammock: boolean; basis: string; note: string;
  es: number; ef: number; float: number; critical: boolean; start: string | null; finish: string | null;
}

/** Critical path method. hoursByQs: code -> slowest linked row (hours). qsInfo: code -> {section, description, amount}. */
export function computeProgramme(prog: Programme, hoursByQs: Map<string, Dec>, qsInfo: Record<string, QsInfo>) {
  const tasks = prog.tasks;
  const hpd = Number(prog.hours_per_day ?? 8), dpw = Number(prog.days_per_week ?? 5);
  const byCode = new Map(tasks.map((t) => [t.code, t]));
  const problems: string[] = [];
  const dur = new Map<string, number>();
  const derived = new Map<string, number | null>();
  for (const t of tasks) {
    const d = derivedDays(t.qs_code ? hoursByQs.get(t.qs_code) : null, hpd);
    derived.set(t.code, d);
    dur.set(t.code, t.override_days !== null ? Number(t.override_days) : (d ?? 0));
  }
  const preds = new Map<string, string[]>();
  for (const t of tasks) {
    const ok: string[] = [];
    for (const p of t.predecessors) {
      if (byCode.has(p)) ok.push(p);
      else problems.push(`${t.code} follows ${p}, which isn't in the programme.`);
    }
    preds.set(t.code, ok);
  }

  const es = new Map<string, number>();
  const state = new Map<string, number>();
  const forward = (c: string): number => {
    if (es.has(c)) return es.get(c)!;
    if (state.get(c) === 1) {
      problems.push(`${c} is part of a loop of predecessors.`);
      return 0;
    }
    state.set(c, 1);
    const v = Math.max(0, ...preds.get(c)!.map((p) => forward(p) + dur.get(p)!));
    es.set(c, v);
    state.set(c, 2);
    return v;
  };
  for (const t of tasks) forward(t.code);

  const ef = new Map([...es].map(([c, v]) => [c, v + dur.get(c)!]));
  const ham = new Set(tasks.filter((t) => t.hammock).map((t) => t.code));
  const nonHam = [...ef].filter(([c]) => !ham.has(c)).map(([, v]) => v);
  const project = nonHam.length ? Math.max(...nonHam) : ef.size ? Math.max(...ef.values()) : 0;
  const succ = new Map<string, string[]>([...es.keys()].map((c) => [c, []]));
  for (const [c, ps] of preds) for (const p of ps) succ.get(p)!.push(c);

  const lf = new Map<string, number>();
  const backward = (c: string, depth = 0): number => {
    if (lf.has(c)) return lf.get(c)!;
    if (depth > tasks.length + 1) return project;
    const s = succ.get(c)!;
    const v = s.length === 0 ? project : Math.min(...s.map((x) => backward(x, depth + 1) - dur.get(x)!));
    lf.set(c, v);
    return v;
  };
  for (const t of tasks) backward(t.code);

  const start = prog.start ? parseDate(prog.start) : null;
  const out: ProgrammeTaskResult[] = tasks.map((t) => {
    const c = t.code;
    const slack = lf.get(c)! - dur.get(c)! - es.get(c)!;
    const info = t.qs_code ? (qsInfo[t.qs_code] ?? {}) : {};
    return {
      id: t.id, code: c, name: t.name, qs_code: t.qs_code, section: info.section || "Programme controls", amount: info.amount, duration: dur.get(c)!,
      derived: derived.get(c)!, override: t.override_days, predecessors: t.predecessors, hammock: t.hammock, basis: t.basis, note: t.note,
      es: es.get(c)!, ef: ef.get(c)!, float: slack, critical: slack === 0 && dur.get(c)! > 0 && !t.hammock,
      start: start ? iso(workingDate(start, es.get(c)!, dpw)) : null,
      finish: start ? iso(workingDate(start, Math.max(ef.get(c)! - 1, es.get(c)!), dpw)) : null,
    };
  });

  const chain = out.filter((x) => x.critical).sort((a, b) => a.es - b.es || a.ef - b.ef);
  const hammockDays = out.filter((x) => x.hammock).map((x) => x.duration);
  const pathDays = project;
  const usedQs = new Set(tasks.map((t) => t.qs_code));
  const missing = Object.entries(qsInfo)
    .filter(([c, i]) => !usedQs.has(c) && (i.amount ?? 0) !== 0)
    .map(([c, i]) => ({ code: c, description: i.description ?? "", amount: i.amount }));
  if (hammockDays.length && hammockDays.some((h) => h !== pathDays))
    problems.push(`Preliminaries run ${Math.max(...hammockDays)} days but the programme chain is ${pathDays} days.`);

  return {
    tasks: out, duration: pathDays, criticalPath: chain.map((x) => x.code), problems, missing, start: prog.start || "", daysPerWeek: dpw, hoursPerDay: hpd,
    finish: start && pathDays ? iso(workingDate(start, Math.max(pathDays - 1, 0), dpw)) : null,
  };
}
