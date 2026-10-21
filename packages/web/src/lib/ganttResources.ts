/**
 * Resources and assignments for the Gantt, with no screen in it. A resource is a person, plant or material; an assignment puts a resource on a
 * task at some number of units (100% is one full-time person). Tasks keep their fixed duration (assignments here don't change the schedule),
 * so work and cost are worked out from the duration the schedule gives each task:
 *   work resource   work = duration in hours x units, cost = work x standard rate per hour
 *   material        cost = units (the quantity) x standard rate
 *   cost resource   cost = units x standard rate (a fixed amount)
 */
import { D } from "@blackline/engine";
import { gantt as G } from "@blackline/tender/core";

type Project = G.GProject;
export type Edited<T> = { ok: true; body: T } | { ok: false; error: string };

// ---- resource sheet edits ---------------------------------------------------------------------------------------------------------------
export const RESOURCE_TYPES: { value: G.GResource["type"]; label: string }[] = [{ value: "work", label: "Work" }, { value: "material", label: "Material" }, { value: "cost", label: "Cost" }];

export const nextResourceUid = (resources: G.GResource[]) => 1 + Math.max(0, ...resources.map((r) => r.uid));
export const nextAssignmentUid = (assignments: G.GAssignment[]) => 1 + Math.max(0, ...assignments.map((a) => a.uid));

export function newResource(name: string, existing: G.GResource[]): Edited<G.GResource> {
  const n = name.trim();
  if (!n) return { ok: false, error: "Name the resource." };
  if (n.length > 120) return { ok: false, error: "The name is too long (limit 120 characters)." };
  if (/[;,\[\]]/.test(n)) return { ok: false, error: "A resource name can't hold commas, semicolons or square brackets (they separate names in the Resource Names column)." };
  if (existing.some((r) => r.name.toLowerCase() === n.toLowerCase())) return { ok: false, error: `${n} is already a resource.` };
  return { ok: true, body: { uid: nextResourceUid(existing), name: n, type: "work", maxUnits: 1, stdRate: "0", initials: n.slice(0, 2).toUpperCase() } };
}

/** Units as typed: 50%, 50, 0.5 is not read as 50% (a bare number is a percentage, as MS Project's Max Units column shows it). */
export function parseUnits(text: string): number | null {
  const m = /^\s*(\d*\.?\d+)\s*%?\s*$/.exec(text);
  return m ? Math.round(Number(m[1]) * 100) / 10000 : null;
}
export const formatUnits = (u: number) => `${Math.round(u * 10000) / 100}%`;

export function setResourceField(r: G.GResource, field: string, value: unknown, all: G.GResource[]): Edited<G.GResource> {
  const v = String(value ?? "").trim();
  const next = { ...r };
  if (field === "name") {
    const c = newResource(v, all.filter((x) => x.uid !== r.uid));
    if (!c.ok) return c;
    next.name = c.body.name;
  } else if (field === "type") {
    if (!RESOURCE_TYPES.some((t) => t.value === v)) return { ok: false, error: "A resource is Work, Material or Cost." };
    next.type = v as G.GResource["type"];
  } else if (field === "initials") {
    if (v.length > 10) return { ok: false, error: "Initials are up to 10 characters." };
    next.initials = v;
  } else if (field === "maxUnits") {
    const u = parseUnits(v);
    if (u === null) return { ok: false, error: "Max units is a percentage, for example 100% or 250%." };
    next.maxUnits = u;
  } else if (field === "stdRate") {
    const s = v.replace(/,/g, "").replace(/^\$+/, "").replace(/\/(h|hr|hour)$/i, "");
    if (!/^\d*\.?\d+$/.test(s)) return { ok: false, error: "A rate is an amount of money, for example 95 or 95.50." };
    next.stdRate = new D(s).toString();
  } else return { ok: false, error: `'${field}' can't be edited on a resource.` };
  return { ok: true, body: next };
}

// ---- the Resource Names column: "Digger, Labourer[50%], Concrete[12]" ---------------------------------------------------------------------
export function formatAssignments(taskUid: number, project: Project): string {
  return project.assignments.filter((a) => a.taskUid === taskUid)
    .map((a) => ({ a, r: project.resources.find((x) => x.uid === a.resourceUid) })).filter((x) => x.r)
    .map(({ a, r }) => (a.units === 1 ? r!.name : `${r!.name}[${r!.type === "material" ? a.units : formatUnits(a.units)}]`)).join(", ");
}

export interface Wanted { name: string; units: number }

/** "Digger, Labourer[50%]" to names and units; says what is wrong in words. Material units are a plain quantity: Concrete[12]. */
export function parseAssignments(text: string, resources: G.GResource[]): { ok: true; wanted: Wanted[] } | { ok: false; error: string } {
  const wanted: Wanted[] = [];
  for (const part of text.split(/[,;]/).map((x) => x.trim()).filter(Boolean)) {
    const m = /^([^\[\]]+?)\s*(?:\[\s*([^\]]*?)\s*\])?$/.exec(part);
    if (!m) return { ok: false, error: `"${part}" isn't a resource. Write the name, then the units in brackets if it isn't 100%: Digger, Labourer[50%].` };
    const name = m[1]!.trim();
    const existing = resources.find((r) => r.name.toLowerCase() === name.toLowerCase());
    let units = 1;
    if (m[2] !== undefined && m[2] !== "") {
      if (existing?.type === "material" || existing?.type === "cost") {
        if (!/^\d*\.?\d+$/.test(m[2])) return { ok: false, error: `"${m[2]}" isn't a quantity for ${name}.` };
        units = Number(m[2]);
      } else {
        const u = parseUnits(m[2]);
        if (u === null || u === 0) return { ok: false, error: `"${m[2]}" isn't units. Try 50% or 200%.` };
        units = u;
      }
    }
    if (wanted.some((w) => w.name.toLowerCase() === name.toLowerCase())) return { ok: false, error: `${name} is listed twice.` };
    wanted.push({ name, units });
  }
  return { ok: true, wanted };
}

export interface AssignChange { resources: G.GResource[]; upserts: G.GAssignment[]; deletes: number[] }

/** What to write so a task has exactly these resources. A name that isn't a resource yet becomes one (a Work resource at 100% max, as MS Project does). */
export function assign(project: Project, taskUid: number, wanted: Wanted[]): AssignChange {
  const resources = [...project.resources];
  const created: G.GResource[] = [];
  const have = project.assignments.filter((a) => a.taskUid === taskUid);
  const upserts: G.GAssignment[] = [];
  const keep = new Set<number>();
  let nextA = nextAssignmentUid(project.assignments);
  for (const w of wanted) {
    let r = resources.find((x) => x.name.toLowerCase() === w.name.toLowerCase());
    if (!r) {
      const made = newResource(w.name, resources);
      if (!made.ok) continue;
      r = made.body;
      resources.push(r);
      created.push(r);
    }
    const old = have.find((a) => a.resourceUid === r!.uid);
    if (old) { keep.add(old.uid); if (old.units !== w.units) upserts.push({ ...old, units: w.units }); }
    else upserts.push({ uid: nextA++, taskUid, resourceUid: r.uid, units: w.units });
  }
  return { resources: created, upserts, deletes: have.filter((a) => !keep.has(a.uid)).map((a) => a.uid) };
}

// ---- work and cost ---------------------------------------------------------------------------------------------------------------------
export interface Totals { workMin: number; cost: number }

/** Work (minutes) and cost for every task, summary tasks adding up what is inside them. */
export function taskTotals(project: Project, sched: G.ScheduleResult): Map<number, Totals> {
  const out = new Map<number, Totals>();
  const res = new Map(project.resources.map((r) => [r.uid, r]));
  for (const t of sched.tasks) {
    if (t.summary) continue;
    let work = 0, cost = new D(0);
    for (const a of project.assignments) {
      if (a.taskUid !== t.uid) continue;
      const r = res.get(a.resourceUid);
      if (!r) continue;
      if (r.type === "work") { const w = t.durationMin * a.units; work += w; cost = cost.plus(new D(w).div(60).times(r.stdRate || 0)); }
      else cost = cost.plus(new D(a.units).times(r.stdRate || 0));
    }
    out.set(t.uid, { workMin: Math.round(work), cost: cost.toNumber() });
  }
  const roll = (uid: number): Totals => {
    const s = sched.byUid.get(uid)!;
    if (!s.summary) return out.get(uid) ?? { workMin: 0, cost: 0 };
    const kids = s.childUids.map(roll);
    const t = { workMin: kids.reduce((a, k) => a + k.workMin, 0), cost: kids.reduce((a, k) => a + k.cost, 0) };
    out.set(uid, t);
    return t;
  };
  sched.tasks.filter((t) => t.parentUid === null).forEach((t) => roll(t.uid));
  return out;
}

export interface ResourceUse { workMin: number; cost: number; tasks: number; peak: number; over: boolean }

/** For each resource: work, cost, tasks it is on, and the most units it is asked for at once; over-allocated when that tops its max units. */
export function resourceUse(project: Project, sched: G.ScheduleResult): Map<number, ResourceUse> {
  const out = new Map<number, ResourceUse>();
  for (const r of project.resources) {
    const mine = project.assignments.filter((a) => a.resourceUid === r.uid)
      .map((a) => ({ a, s: sched.byUid.get(a.taskUid), t: project.tasks.find((t) => t.uid === a.taskUid) }))
      .filter((x) => x.s && !x.s.summary && x.t?.active);
    let workMin = 0, cost = new D(0);
    for (const { a, s } of mine) {
      if (r.type === "work") { const w = s!.durationMin * a.units; workMin += w; cost = cost.plus(new D(w).div(60).times(r.stdRate || 0)); }
      else cost = cost.plus(new D(a.units).times(r.stdRate || 0));
    }
    // peak: sweep the start and finish of each assignment (work resources only; a quantity of material isn't "at once")
    let peak = 0;
    if (r.type === "work") {
      const ev: { t: number; d: number }[] = [];
      for (const { a, s } of mine) if (s!.finishMin > s!.startMin) { ev.push({ t: s!.startMin, d: a.units }, { t: s!.finishMin, d: -a.units }); }
      ev.sort((x, y) => x.t - y.t || x.d - y.d); // finishes before starts at the same moment
      let cur = 0;
      for (const e of ev) { cur += e.d; if (cur > peak) peak = cur; }
    }
    out.set(r.uid, { workMin: Math.round(workMin), cost: cost.toNumber(), tasks: mine.length, peak: Math.round(peak * 10000) / 10000, over: peak > r.maxUnits + 1e-9 });
  }
  return out;
}
