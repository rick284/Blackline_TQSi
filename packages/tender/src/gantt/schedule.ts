/**
 * The Gantt scheduling engine: a critical path method over working calendars, like MS Project's.
 *
 * Forward pass: each task starts as soon as its links and constraint allow (ASAP), finishing after its working duration.
 * Backward pass: each task finishes as late as its successors, constraints and deadline allow; the gap is total slack, and a task with
 * no slack (or less) is critical. Summary tasks roll up their children. Links to or from a summary task apply to everything inside it.
 * Problems (a loop, a link to a task that isn't there, a constraint that can't be met) are reported, never thrown.
 */
import { WorkCalendar, fromMin, toMin } from "./calendar.js";
import type { GProject, GTask, Link } from "./types.js";
import { standardCalendar } from "./types.js";

export interface ScheduledTask {
  uid: number;
  /** Row number, 1 for the first task (MS Project's ID) */
  id: number;
  wbs: string;
  level: number;
  summary: boolean;
  parentUid: number | null;
  childUids: number[];
  /** Working minutes; for a summary, the working time from its first start to its last finish */
  durationMin: number;
  start: string;
  finish: string;
  startMin: number;
  finishMin: number;
  lateStart: string;
  lateFinish: string;
  /** Working minutes; negative when a constraint or deadline can't be met */
  totalSlackMin: number;
  freeSlackMin: number;
  critical: boolean;
  /** For a summary, the duration-weighted average of its children */
  percent: number;
  /** Set when a constraint or deadline is missed */
  violation: string | null;
}

export interface ScheduleResult {
  tasks: ScheduledTask[];
  byUid: Map<number, ScheduledTask>;
  start: string;
  finish: string;
  problems: string[];
}

interface Edge { from: number; to: number; type: Link["type"]; lag: number }

export function schedule(project: GProject): ScheduleResult {
  const problems: string[] = [];
  const cals = new Map<number, WorkCalendar>();
  const calFor = (uid: number | null): WorkCalendar => {
    const want = uid ?? project.calendarUid;
    let c = cals.get(want);
    if (!c) {
      const def = project.calendars.find((x) => x.uid === want) ?? project.calendars[0] ?? standardCalendar();
      c = new WorkCalendar(def);
      if (!c.hasWork) problems.push(`The calendar "${def.name}" has no working time, so its tasks are scheduled as if every minute were working.`);
      cals.set(want, c);
    }
    return c;
  };

  const all = project.tasks;
  const byUid = new Map(all.map((t) => [t.uid, t]));
  const projectStart = toMin(project.start);
  const projCal = calFor(null);
  const startOfProject = projCal.nextStart(projectStart);

  // ---- outline
  const parent = new Map<number, number | null>();
  const children = new Map<number, number[]>(all.map((t) => [t.uid, []]));
  const stack: GTask[] = [];
  all.forEach((t, i) => {
    const level = Math.max(1, t.outline);
    const prev = all[i - 1];
    if (prev && level > Math.max(1, prev.outline) + 1) problems.push(`"${t.name}" is indented more than one level below the task above it.`);
    while (stack.length && Math.max(1, stack[stack.length - 1]!.outline) >= level) stack.pop();
    const p = stack[stack.length - 1] ?? null;
    parent.set(t.uid, p ? p.uid : null);
    if (p) children.get(p.uid)!.push(t.uid);
    stack.push(t);
  });
  const isSummary = (uid: number) => children.get(uid)!.length > 0;
  const ancestors = (uid: number): number[] => { const out: number[] = []; for (let p = parent.get(uid) ?? null; p !== null; p = parent.get(p) ?? null) out.push(p); return out; };
  const leavesOf = (uid: number): number[] => (isSummary(uid) ? children.get(uid)!.flatMap(leavesOf) : [uid]);

  // ---- links: a link given to a summary applies to every task inside it
  const incoming = new Map<number, Edge[]>(all.map((t) => [t.uid, []]));
  const outgoing = new Map<number, Edge[]>(all.map((t) => [t.uid, []]));
  for (const t of all) {
    if (!t.active) continue;
    for (const l of t.links) {
      const src = byUid.get(l.uid);
      if (!src) { problems.push(`"${t.name}" follows task ${l.uid}, which isn't in the project.`); continue; }
      if (!src.active) continue;
      if (l.uid === t.uid) { problems.push(`"${t.name}" can't follow itself.`); continue; }
      const e: Edge = { from: l.uid, to: t.uid, type: l.type, lag: l.lagMin };
      outgoing.get(l.uid)!.push(e);
      for (const target of [t.uid, ...(isSummary(t.uid) ? leavesOf(t.uid) : [])]) if (target === t.uid || !isSummary(target)) incoming.get(target)!.push(e);
    }
  }

  const dur = (t: GTask) => (t.milestone ? 0 : Math.max(0, t.durationMin));
  const calOf = (t: GTask) => calFor(t.calendarUid);

  // ---- forward pass
  const es = new Map<number, number>();
  const ef = new Map<number, number>();
  const fwdState = new Map<number, number>();
  const forward = (uid: number): void => {
    if (es.has(uid)) return;
    const t = byUid.get(uid)!;
    if (fwdState.get(uid) === 1) { problems.push(`"${t.name}" is part of a loop of links.`); es.set(uid, startOfProject); ef.set(uid, startOfProject); return; }
    fwdState.set(uid, 1);
    if (isSummary(uid)) {
      for (const c of children.get(uid)!) forward(c);
      const cs = children.get(uid)!.filter((c) => byUid.get(c)!.active);
      const pool = cs.length ? cs : children.get(uid)!;
      es.set(uid, Math.min(...pool.map((c) => es.get(c)!)));
      ef.set(uid, Math.max(...pool.map((c) => ef.get(c)!)));
      fwdState.set(uid, 2);
      return;
    }
    const cal = calOf(t);
    const d = dur(t);
    // earliest start from the project start, then each link and the constraint
    let start = cal.nextStart(startOfProject);
    const need = (s: number) => { if (s > start) start = s; };
    const edges = t.active ? incoming.get(uid)! : [];
    for (const e of edges) {
      forward(e.from);
      const pS = es.get(e.from)!, pF = ef.get(e.from)!;
      if (e.type === "FS") need(d === 0 ? shift(cal, pF, e.lag) : cal.nextStart(shift(cal, pF, e.lag)));
      else if (e.type === "SS") need(d === 0 ? shift(cal, pS, e.lag) : cal.nextStart(shift(cal, pS, e.lag)));
      else {
        const fin = shift(cal, e.type === "FF" ? pF : pS, e.lag);
        need(d === 0 ? fin : cal.sub(fin, d));
      }
    }
    const date = t.constraintDate ? toMin(t.constraintDate) : null;
    if (date !== null) {
      if (t.constraint === "SNET") need(d === 0 ? date : cal.nextStart(date));
      else if (t.constraint === "FNET") need(d === 0 ? date : cal.sub(date, d));
      else if (t.constraint === "MSO") start = d === 0 ? date : cal.nextStart(date);
      else if (t.constraint === "MFO") start = d === 0 ? date : cal.sub(date, d);
    }
    es.set(uid, start);
    ef.set(uid, d === 0 ? start : cal.add(start, d));
    fwdState.set(uid, 2);
  };
  all.forEach((t) => forward(t.uid));

  const leafActive = all.filter((t) => !isSummary(t.uid) && t.active);
  const projectFinish = leafActive.length ? Math.max(...leafActive.map((t) => ef.get(t.uid)!)) : startOfProject;

  // ---- backward pass
  const lf = new Map<number, number>();
  const ls = new Map<number, number>();
  const bwdState = new Map<number, number>();
  const backward = (uid: number): void => {
    if (lf.has(uid)) return;
    const t = byUid.get(uid)!;
    if (bwdState.get(uid) === 1) { lf.set(uid, projectFinish); ls.set(uid, projectFinish); return; }
    bwdState.set(uid, 1);
    if (isSummary(uid)) {
      for (const c of children.get(uid)!) backward(c);
      lf.set(uid, Math.max(...children.get(uid)!.map((c) => lf.get(c)!)));
      ls.set(uid, Math.min(...children.get(uid)!.map((c) => ls.get(c)!)));
      bwdState.set(uid, 2);
      return;
    }
    const cal = calOf(t);
    const d = dur(t);
    let late = projectFinish; // the latest finish
    const lim = (f: number) => { if (f < late) late = f; };
    if (t.active) {
      // links out of this task, and out of any summary it is inside
      const edges = [uid, ...ancestors(uid)].flatMap((u) => outgoing.get(u)!);
      for (const e of edges) {
        backward(e.to);
        const sS = ls.get(e.to)!, sF = lf.get(e.to)!;
        if (e.type === "FS") lim(unshift(cal, sS, e.lag));
        else if (e.type === "FF") lim(unshift(cal, sF, e.lag));
        else if (e.type === "SS") lim(d === 0 ? unshift(cal, sS, e.lag) : cal.add(unshift(cal, sS, e.lag), d));
        else lim(d === 0 ? unshift(cal, sF, e.lag) : cal.add(unshift(cal, sF, e.lag), d));
      }
    }
    const date = t.constraintDate ? toMin(t.constraintDate) : null;
    if (date !== null) {
      if (t.constraint === "FNLT" || t.constraint === "MFO") lim(date);
      else if (t.constraint === "SNLT" || t.constraint === "MSO") lim(d === 0 ? date : cal.add(date, d));
    }
    if (t.deadline) lim(toMin(t.deadline));
    if (d > 0) late = cal.prevEnd(late); // a finish is the end of working time, not the start of the next window
    lf.set(uid, late);
    ls.set(uid, d === 0 ? late : cal.sub(late, d));
    bwdState.set(uid, 2);
  };
  all.forEach((t) => backward(t.uid));

  // As Late As Possible: sit at the late dates
  for (const t of all) {
    if (isSummary(t.uid) || !t.active || t.constraint !== "ALAP") continue;
    es.set(t.uid, ls.get(t.uid)!);
    ef.set(t.uid, lf.get(t.uid)!);
  }
  // summaries follow their children again (an ALAP child may have moved)
  const reroll = (uid: number): void => {
    if (!isSummary(uid)) return;
    children.get(uid)!.forEach(reroll);
    const cs = children.get(uid)!.filter((c) => byUid.get(c)!.active);
    const pool = cs.length ? cs : children.get(uid)!;
    es.set(uid, Math.min(...pool.map((c) => es.get(c)!)));
    ef.set(uid, Math.max(...pool.map((c) => ef.get(c)!)));
  };
  all.filter((t) => parent.get(t.uid) === null).forEach((t) => reroll(t.uid));

  // ---- results: slack, free slack, critical, roll-ups
  const slack = new Map<number, number>();
  const free = new Map<number, number>();
  const slackOf = (uid: number): number => {
    if (slack.has(uid)) return slack.get(uid)!;
    const t = byUid.get(uid)!;
    let s: number;
    if (isSummary(uid)) s = Math.min(...children.get(uid)!.map(slackOf));
    else {
      const cal = calOf(t);
      s = ef.get(uid)! <= lf.get(uid)! ? cal.between(ef.get(uid)!, lf.get(uid)!) : -cal.between(lf.get(uid)!, ef.get(uid)!);
    }
    slack.set(uid, s);
    return s;
  };
  const freeOf = (t: GTask): number => {
    if (isSummary(t.uid)) return 0;
    const cal = calOf(t);
    const succ = t.active ? outgoing.get(t.uid)! : [];
    if (succ.length === 0) return Math.max(0, cal.between(ef.get(t.uid)!, projectFinish));
    let gap = Infinity;
    for (const e of succ) {
      for (const target of isSummary(e.to) ? leavesOf(e.to) : [e.to]) {
        const a = e.type === "FS" || e.type === "FF" ? ef.get(t.uid)! : es.get(t.uid)!;
        const b = e.type === "FS" || e.type === "SS" ? es.get(target)! : ef.get(target)!;
        gap = Math.min(gap, cal.between(shift(cal, a, e.lag), b));
      }
    }
    return Number.isFinite(gap) ? Math.max(0, gap) : 0;
  };

  const percentOf = (uid: number): number => {
    const t = byUid.get(uid)!;
    if (!isSummary(uid)) return Math.min(100, Math.max(0, t.percent));
    const parts = leavesOf(uid).map((u) => ({ d: dur(byUid.get(u)!), p: Math.min(100, Math.max(0, byUid.get(u)!.percent)) }));
    const total = parts.reduce((a, x) => a + x.d, 0);
    return total ? Math.round(parts.reduce((a, x) => a + x.d * x.p, 0) / total) : parts.length ? Math.round(parts.reduce((a, x) => a + x.p, 0) / parts.length) : 0;
  };

  // WBS numbering
  const wbs = new Map<number, string>();
  const number = (uids: number[], prefix: string) => uids.forEach((u, i) => { const w = prefix ? `${prefix}.${i + 1}` : String(i + 1); wbs.set(u, w); number(children.get(u)!, w); });
  number(all.filter((t) => parent.get(t.uid) === null).map((t) => t.uid), "");

  const out: ScheduledTask[] = all.map((t, i) => {
    const cal = calOf(t);
    const s = es.get(t.uid)!, f = ef.get(t.uid)!;
    const sl = slackOf(t.uid);
    const ct = t.constraint;
    let violation: string | null = null;
    if (t.active) {
      const date = t.constraintDate ? toMin(t.constraintDate) : null;
      if (date !== null && !isSummary(t.uid)) {
        if (ct === "MSO" && s !== date && s > date) violation = "Can't start on its date: a link pushes it later.";
        else if (ct === "FNLT" && f > date) violation = "Finishes after its Finish No Later Than date.";
        else if (ct === "SNLT" && s > date) violation = "Starts after its Start No Later Than date.";
        else if (ct === "MFO" && f > date) violation = "Can't finish on its date: a link pushes it later.";
      }
      if (t.deadline && f > toMin(t.deadline)) violation = "Finishes after its deadline.";
    }
    const d = isSummary(t.uid) ? Math.max(0, cal.between(s, f)) : dur(t);
    return {
      uid: t.uid, id: i + 1, wbs: wbs.get(t.uid)!, level: Math.max(1, t.outline), summary: isSummary(t.uid), parentUid: parent.get(t.uid) ?? null, childUids: children.get(t.uid)!,
      durationMin: d, start: fromMin(s), finish: fromMin(f), startMin: s, finishMin: f, lateStart: fromMin(ls.get(t.uid)!), lateFinish: fromMin(lf.get(t.uid)!),
      totalSlackMin: sl, freeSlackMin: freeOf(t), critical: t.active && sl <= 0, percent: percentOf(t.uid), violation,
    };
  });
  for (const r of out) if (r.violation) problems.push(`"${byUid.get(r.uid)!.name}": ${r.violation}`);

  const finishAll = out.length ? Math.max(...out.map((r) => r.finishMin)) : startOfProject;
  const startAll = out.length ? Math.min(...out.map((r) => r.startMin)) : startOfProject;
  return { tasks: out, byUid: new Map(out.map((r) => [r.uid, r])), start: fromMin(startAll), finish: fromMin(finishAll), problems };
}

/** A moment moved by a lag in the successor's working time (a lead, a negative lag, moves it back). */
function shift(cal: WorkCalendar, t: number, lagMin: number): number {
  if (lagMin === 0) return t;
  return lagMin > 0 ? cal.add(t, lagMin) : cal.sub(t, -lagMin);
}
function unshift(cal: WorkCalendar, t: number, lagMin: number): number {
  return shift(cal, t, -lagMin);
}
