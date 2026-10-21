import { describe, expect, it } from "vitest";
import { WorkCalendar, fromMin, toMin } from "../src/gantt/calendar.js";
import { schedule } from "../src/gantt/schedule.js";
import { newProject, newTask, standardCalendar, type ConstraintType, type GProject, type GTask, type Link } from "../src/gantt/types.js";

// 2026-10-05 is a Monday. Standard calendar: Mon-Fri 08:00-12:00 and 13:00-17:00 (480 working minutes a day).
const D = 480;
const T = (s: string) => toMin(s);
const cal = (holidays: string[] = []) => {
  const c = standardCalendar();
  for (const h of holidays) c.exceptions.push({ name: "Holiday", from: h, to: h, working: false, times: [] });
  return new WorkCalendar(c);
};

type Spec = { days?: number; links?: Link[]; outline?: number; milestone?: boolean; constraint?: ConstraintType; date?: string; deadline?: string; percent?: number; active?: boolean };
function project(specs: Record<number, Spec>, holidays: string[] = []): GProject {
  const p = newProject("2026-10-05T08:00:00");
  for (const c of p.calendars) for (const h of holidays) c.exceptions.push({ name: "Holiday", from: h, to: h, working: false, times: [] });
  for (const [uid, s] of Object.entries(specs)) {
    const t: GTask = newTask(Number(uid), `T${uid}`, s.outline ?? 1);
    t.durationMin = (s.days ?? 1) * D;
    t.links = s.links ?? [];
    t.milestone = !!s.milestone;
    if (t.milestone) t.durationMin = 0;
    t.constraint = s.constraint ?? "ASAP";
    t.constraintDate = s.date ?? null;
    t.deadline = s.deadline ?? null;
    t.percent = s.percent ?? 0;
    t.active = s.active ?? true;
    p.tasks.push(t);
  }
  return p;
}
const fs = (uid: number, lagDays = 0): Link => ({ uid, type: "FS", lagMin: lagDays * D });
const r = (p: GProject) => schedule(p);

describe("working calendar", () => {
  const c = cal(["2026-10-12"]);
  it("adds working time across lunch, nights and weekends", () => {
    expect(fromMin(c.add(T("2026-10-05T08:00:00"), D))).toBe("2026-10-05T17:00:00");
    expect(fromMin(c.add(T("2026-10-05T08:00:00"), 300))).toBe("2026-10-05T14:00:00");
    expect(fromMin(c.add(T("2026-10-09T16:00:00"), 120))).toBe("2026-10-13T09:00:00"); // Mon 12 Oct is a holiday
    expect(fromMin(c.add(T("2026-10-05T08:00:00"), 0))).toBe("2026-10-05T08:00:00");
  });
  it("finds the next start and the last finish", () => {
    expect(fromMin(c.nextStart(T("2026-10-10T10:00:00")))).toBe("2026-10-13T08:00:00"); // Saturday, then a holiday Monday
    expect(fromMin(c.nextStart(T("2026-10-05T12:00:00")))).toBe("2026-10-05T13:00:00");
    expect(fromMin(c.prevEnd(T("2026-10-06T08:00:00")))).toBe("2026-10-05T17:00:00");
  });
  it("goes back and counts working minutes", () => {
    expect(fromMin(c.sub(T("2026-10-06T09:00:00"), 120))).toBe("2026-10-05T16:00:00");
    expect(c.between(T("2026-10-09T16:00:00"), T("2026-10-13T09:00:00"))).toBe(120);
    expect(c.between(T("2026-10-05T08:00:00"), T("2026-10-05T17:00:00"))).toBe(D);
    expect(c.between(T("2026-10-06T08:00:00"), T("2026-10-05T08:00:00"))).toBe(-D);
  });
});

describe("links", () => {
  it("starts the first task at the project start and runs a finish-to-start chain", () => {
    const s = r(project({ 1: { days: 5 }, 2: { days: 2, links: [fs(1)] } }));
    expect([s.byUid.get(1)!.start, s.byUid.get(1)!.finish]).toEqual(["2026-10-05T08:00:00", "2026-10-09T17:00:00"]);
    expect([s.byUid.get(2)!.start, s.byUid.get(2)!.finish]).toEqual(["2026-10-12T08:00:00", "2026-10-13T17:00:00"]);
    expect(s.finish).toBe("2026-10-13T17:00:00");
  });
  it("skips a holiday", () => {
    const s = r(project({ 1: { days: 5 }, 2: { days: 2, links: [fs(1)] } }, ["2026-10-12"]));
    expect([s.byUid.get(2)!.start, s.byUid.get(2)!.finish]).toEqual(["2026-10-13T08:00:00", "2026-10-14T17:00:00"]);
  });
  it("start-to-start with a lag", () => {
    const s = r(project({ 1: { days: 5 }, 2: { days: 2, links: [{ uid: 1, type: "SS", lagMin: D }] } }));
    expect(s.byUid.get(2)!.start).toBe("2026-10-06T08:00:00");
  });
  it("finish-to-finish pulls the start back", () => {
    const s = r(project({ 1: { days: 5 }, 2: { days: 2, links: [{ uid: 1, type: "FF", lagMin: 0 }] } }));
    expect([s.byUid.get(2)!.start, s.byUid.get(2)!.finish]).toEqual(["2026-10-08T08:00:00", "2026-10-09T17:00:00"]);
  });
  it("start-to-finish can't pull a task before the project start", () => {
    const s = r(project({ 1: { days: 5 }, 2: { days: 1, links: [{ uid: 1, type: "SF", lagMin: 0 }] } }));
    expect([s.byUid.get(2)!.start, s.byUid.get(2)!.finish]).toEqual(["2026-10-05T08:00:00", "2026-10-05T17:00:00"]);
  });
  it("a negative lag is a lead", () => {
    const s = r(project({ 1: { days: 5 }, 2: { days: 2, links: [fs(1, -1)] } }));
    expect([s.byUid.get(2)!.start, s.byUid.get(2)!.finish]).toEqual(["2026-10-09T08:00:00", "2026-10-12T17:00:00"]);
  });
  it("a milestone sits at the end of what it follows", () => {
    const s = r(project({ 1: { days: 5 }, 2: { milestone: true, links: [fs(1)] } }));
    expect([s.byUid.get(2)!.start, s.byUid.get(2)!.finish]).toEqual(["2026-10-09T17:00:00", "2026-10-09T17:00:00"]);
    expect(s.byUid.get(2)!.durationMin).toBe(0);
  });
  it("the latest predecessor wins", () => {
    const s = r(project({ 1: { days: 2 }, 2: { days: 4 }, 3: { days: 1, links: [fs(1), fs(2)] } }));
    expect(s.byUid.get(3)!.start).toBe("2026-10-09T08:00:00");
  });
});

describe("constraints", () => {
  it("Start No Earlier Than waits, and counts working time from the moment it starts", () => {
    const s = r(project({ 1: { days: 1, constraint: "SNET", date: "2026-10-07T10:00:00" } }));
    expect([s.byUid.get(1)!.start, s.byUid.get(1)!.finish]).toEqual(["2026-10-07T10:00:00", "2026-10-08T10:00:00"]);
  });
  it("Must Start On holds its date, and says when a link pushes the task past it", () => {
    const ok = r(project({ 1: { days: 1, constraint: "MSO", date: "2026-10-08T08:00:00" } }));
    expect(ok.byUid.get(1)!.start).toBe("2026-10-08T08:00:00");
    const late = r(project({ 1: { days: 5 }, 2: { days: 1, links: [fs(1)], constraint: "MSO", date: "2026-10-07T08:00:00" } }));
    expect(late.byUid.get(2)!.start).toBe("2026-10-07T08:00:00"); // Must Start On overrides the link
    expect(late.byUid.get(2)!.violation).toBeNull();
  });
  it("Finish No Later Than that is missed gives negative slack and a problem", () => {
    const s = r(project({ 1: { days: 3 }, 2: { days: 2, links: [fs(1)], constraint: "FNLT", date: "2026-10-08T17:00:00" } }));
    expect(s.byUid.get(2)!.finish).toBe("2026-10-09T17:00:00");
    expect(s.byUid.get(2)!.totalSlackMin).toBe(-D);
    expect(s.byUid.get(2)!.critical).toBe(true);
    expect(s.problems.join(" ")).toContain("Finish No Later Than");
  });
  it("a deadline that is missed is reported", () => {
    const s = r(project({ 1: { days: 5, deadline: "2026-10-07T17:00:00" } }));
    expect(s.byUid.get(1)!.totalSlackMin).toBe(-2 * D);
    expect(s.problems.join(" ")).toContain("deadline");
  });
  it("As Late As Possible sits at the end of its slack", () => {
    const s = r(project({ 1: { days: 5 }, 2: { days: 1, constraint: "ALAP" } }));
    expect([s.byUid.get(2)!.start, s.byUid.get(2)!.finish]).toEqual(["2026-10-09T08:00:00", "2026-10-09T17:00:00"]);
    expect(s.byUid.get(2)!.totalSlackMin).toBe(0);
  });
});

describe("critical path and slack", () => {
  const p = () => project({ 1: { days: 5 }, 2: { days: 3 }, 3: { days: 2, links: [fs(1), fs(2)] } });
  it("finds the path, and the slack and free slack off it", () => {
    const s = r(p());
    expect(s.byUid.get(1)!.critical).toBe(true);
    expect(s.byUid.get(3)!.critical).toBe(true);
    const b = s.byUid.get(2)!;
    expect(b.critical).toBe(false);
    expect(b.totalSlackMin).toBe(2 * D);
    expect(b.freeSlackMin).toBe(2 * D);
    expect(b.lateFinish).toBe("2026-10-09T17:00:00");
    expect(s.byUid.get(1)!.totalSlackMin).toBe(0);
  });
  it("a longer branch takes over the critical path", () => {
    const q = p();
    q.tasks[1]!.durationMin = 7 * D;
    const s = r(q);
    expect(s.byUid.get(2)!.critical).toBe(true);
    expect(s.byUid.get(1)!.critical).toBe(false);
    expect(s.byUid.get(1)!.totalSlackMin).toBe(2 * D);
  });
  it("an inactive task takes no part", () => {
    const q = p();
    q.tasks[0]!.active = false;
    const s = r(q);
    expect(s.byUid.get(3)!.start).toBe("2026-10-08T08:00:00"); // follows task 2 (3 days) only
  });
});

describe("outline", () => {
  const outline = () => project({ 1: { outline: 1 }, 2: { outline: 2, days: 3, percent: 100 }, 3: { outline: 2, days: 2, links: [fs(2)], percent: 0 }, 4: { outline: 1, days: 1 } });
  it("rolls a summary up from its children", () => {
    const s = r(outline());
    const sum = s.byUid.get(1)!;
    expect(sum.summary).toBe(true);
    expect([sum.start, sum.finish]).toEqual(["2026-10-05T08:00:00", "2026-10-09T17:00:00"]);
    expect(sum.durationMin).toBe(5 * D);
    expect(sum.percent).toBe(60); // (3 days x 100% + 2 days x 0%) / 5 days
    expect(s.tasks.map((t) => t.wbs)).toEqual(["1", "1.1", "1.2", "2"]);
    expect(s.byUid.get(3)!.parentUid).toBe(1);
  });
  it("a link to a summary applies to every task inside it", () => {
    const q = outline();
    q.tasks[3]!.links = [];
    q.tasks[0]!.links = [fs(4)]; // summary follows task 4 (1 day)
    const s = r(q);
    expect(s.byUid.get(2)!.start).toBe("2026-10-06T08:00:00");
    expect(s.byUid.get(3)!.start).toBe("2026-10-09T08:00:00");
  });
  it("a link from a summary waits for everything inside it", () => {
    const q = project({ 1: { outline: 1 }, 2: { outline: 2, days: 3 }, 3: { outline: 2, days: 1 }, 4: { days: 1, links: [fs(1)] } });
    expect(r(q).byUid.get(4)!.start).toBe("2026-10-08T08:00:00");
  });
});

describe("problems are reported, not thrown", () => {
  it("a loop of links", () => {
    const s = r(project({ 1: { links: [fs(2)] }, 2: { links: [fs(1)] } }));
    expect(s.problems.join(" ")).toContain("loop");
    expect(s.tasks).toHaveLength(2);
  });
  it("a link to a task that isn't there", () => {
    const s = r(project({ 1: { links: [fs(99)] } }));
    expect(s.problems.join(" ")).toContain("isn't in the project");
  });
  it("an empty project", () => {
    const s = r(newProject("2026-10-05T08:00:00"));
    expect(s.tasks).toEqual([]);
  });
});
