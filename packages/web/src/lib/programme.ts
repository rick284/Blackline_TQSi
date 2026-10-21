/**
 * Tender programme edits, with no screen in them. The rules (task codes, whole-day overrides, predecessors that can't follow
 * themselves) belong to the tender package's `programme` module; these turn what was typed into a new record body, or a sentence saying
 * what is wrong with it.
 */
import { ProgrammeError, buildTask, setConfig, setTaskField, type Programme, type ProgrammeTask, type RecordData } from "@blackline/tender/core";

export type ProgrammeConfig = Pick<Programme, "start" | "days_per_week" | "hours_per_day">;
export type Edited<T> = { ok: true; body: T } | { ok: false; error: string };
export type Made = { ok: true; recordId: string; data: RecordData } | { ok: false; error: string };

function guard(fn: () => void): { ok: true } | { ok: false; error: string } {
  try { fn(); return { ok: true }; } catch (e) {
    if (e instanceof ProgrammeError) return { ok: false, error: e.message };
    throw e;
  }
}

export function setConfigField(body: ProgrammeConfig, field: string, value: unknown): Edited<ProgrammeConfig> {
  const p: Programme = { ...body, tasks: [] };
  const r = guard(() => setConfig(p, field, value));
  return r.ok ? { ok: true, body: { start: p.start, days_per_week: p.days_per_week, hours_per_day: p.hours_per_day } } : r;
}

/** `all` is every task (so a new code is checked against the others and a task can't follow itself). */
export function setTaskFieldEdit(body: ProgrammeTask, field: string, value: unknown, all: ProgrammeTask[]): Edited<ProgrammeTask> {
  const next = { ...body, predecessors: [...body.predecessors] };
  const r = guard(() => setTaskField(next, field, value, all.map((x) => (x.id === body.id ? next : x))));
  return r.ok ? { ok: true, body: next } : r;
}

/** The next free task id: P-00001, P-00002 ... (permanent; the code people see is separate). */
export function nextTaskId(ids: string[]): string {
  const taken = new Set(ids);
  for (let n = 1; ; n++) { const id = `P-${String(n).padStart(5, "0")}`; if (!taken.has(id)) return id; }
}

/** A new control task from its code (the name starts as the code, to be typed over). It has no cost and no duration until one is entered. */
export function newTask(code: string, all: ProgrammeTask[], seq: number): Made {
  const id = nextTaskId(all.map((t) => t.id));
  try {
    const t = buildTask(id, { code: code.trim(), name: code.trim() }, all);
    return { ok: true, recordId: `task:${id}`, data: { kind: "task", seq, body: t } };
  } catch (e) {
    if (e instanceof ProgrammeError) return { ok: false, error: e.message };
    throw e;
  }
}

/** A programme for a job that has none: one task per QS item that carries cost, in takeoff order, each with the duration its resources give. */
export function startFromEstimate(items: { code: string; description: string; amount: { isZero(): boolean } }[], start: string): { config: RecordData; tasks: { recordId: string; data: RecordData }[] } {
  const priced = items.filter((i) => !i.amount.isZero());
  const tasks = priced.map((i, n) => {
    const id = `P-${String(n + 1).padStart(5, "0")}`;
    const t: ProgrammeTask = { id, code: i.code, name: (i.description || i.code).slice(0, 200), qs_code: i.code, override_days: null, predecessors: [], hammock: false, basis: "", note: "" };
    return { recordId: `task:${id}`, data: { kind: "task", seq: n + 1, body: t } as RecordData };
  });
  return { config: { kind: "programmeConfig", body: { start, days_per_week: 5, hours_per_day: 8 } }, tasks };
}
