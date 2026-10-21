import { describe, expect, it } from "vitest";
import { gantt as G } from "@blackline/tender/core";
import * as K from "../src/lib/ganttColumns.js";
import { taskTotals } from "../src/lib/ganttResources.js";

const D = 480;
function build() {
  const p = G.newProject("2026-10-05T08:00:00");
  const t = (uid: number, name: string, days: number, outline = 1, links: G.Link[] = [], more: Partial<G.GTask> = {}) => { const x = { ...G.newTask(uid, name, outline), durationMin: days * D, links, ...more }; p.tasks.push(x); };
  t(1, "Earthworks", 0);
  t(2, "Strip topsoil", 2, 2, [], { percent: 100 });
  t(3, "Bulk fill", 5, 2, [{ uid: 2, type: "FS", lagMin: 0 }]);
  t(4, "Pavements", 0);
  t(5, "Basecourse", 3, 2, [{ uid: 3, type: "FS", lagMin: 0 }]);
  t(6, "Completion", 0, 1, [{ uid: 5, type: "FS", lagMin: 0 }], { milestone: true });
  t(7, "Landscaping", 1, 1); // free-floating, not critical
  p.resources.push({ uid: 1, name: "Digger", type: "work", maxUnits: 1, stdRate: "100", initials: "DG" });
  p.assignments.push({ uid: 1, taskUid: 3, resourceUid: 1, units: 1 });
  const sched = G.schedule(p);
  const ctx: K.Ctx = { project: p, sched, totals: taskTotals(p, sched), wc: new G.WorkCalendar(p.calendars[0]!), today: G.toMin("2026-10-20T12:00:00") };
  const rows: K.Row[] = p.tasks.map((task) => ({ task, s: sched.byUid.get(task.uid)! }));
  return { p, ctx, rows };
}
const names = (r: { rows: K.Row[] }) => r.rows.map((x) => x.task.name);
const none = { filter: K.NO_FILTER, sort: null, collapsed: new Set<number>() };

describe("columns", () => {
  const { ctx, rows } = build();
  const text = (key: string, uid: number) => K.COLUMN_BY_KEY.get(key)!.text(rows.find((r) => r.task.uid === uid)!, ctx);
  it("shows each fact the way MS Project does", () => {
    expect(text("id", 3)).toBe("3");
    expect(text("wbs", 3)).toBe("1.2");
    expect(text("duration", 3)).toBe("5 days");
    expect(text("duration", 6)).toBe("0 days");
    expect(text("start", 3)).toBe("Wed 7/10/26");
    expect(text("pred", 3)).toBe("2");
    expect(text("percent", 2)).toBe("100%");
    expect(text("resources", 3)).toBe("Digger");
    expect(text("work", 3)).toBe("40 hrs");
    expect(text("cost", 3)).toBe("$4,000");
    expect(text("work", 2)).toBe("");
    expect(text("critical", 3)).toBe("Yes");
    expect(text("critical", 7)).toBe("No");
    expect(text("totalSlack", 7)).toBe("9 days"); // Landscaping (1 day) could slip to the end of the 10-day project
    expect(text("constraint", 3)).toBe("As Soon As Possible");
    expect(text("baselineStart", 3)).toBe("");
  });
  it("shows variance against a baseline", () => {
    const { p } = build();
    const s0 = G.schedule(p);
    p.tasks[2]!.baseline = { start: s0.byUid.get(3)!.start, finish: s0.byUid.get(3)!.finish, durationMin: 5 * D };
    p.tasks[1]!.durationMin = 4 * D; // Strip now takes 4 days, so Fill slips two days
    const s1 = G.schedule(p);
    const c: K.Ctx = { project: p, sched: s1, totals: new Map(), wc: new G.WorkCalendar(p.calendars[0]!), today: 0 };
    const r = { task: p.tasks[2]!, s: s1.byUid.get(3)! };
    expect(K.COLUMN_BY_KEY.get("startVariance")!.text(r, c)).toBe("2 days");
    expect(K.COLUMN_BY_KEY.get("finishVariance")!.text(r, c)).toBe("2 days");
  });
  it("keeps the name column, drops unknown ones, and moves columns about", () => {
    expect(K.cleanColumns(["id", "duration", "nonsense", "id"])).toEqual(["id", "name", "duration"]);
    expect(K.cleanColumns(null)).toEqual(K.DEFAULT_COLUMNS);
    expect(K.cleanColumns([])).toEqual(["name"]);
    expect(K.toggleColumn(["id", "name"], "work")).toEqual(["id", "name", "work"]);
    expect(K.toggleColumn(["id", "name", "work"], "work")).toEqual(["id", "name"]);
    expect(K.toggleColumn(["id", "name"], "name")).toEqual(["id", "name"]);
    expect(K.moveColumn(["id", "name", "work"], "work", -1)).toEqual(["id", "work", "name"]);
    expect(K.moveColumn(["id", "name"], "id", -1)).toEqual(["id", "name"]);
  });
});

describe("filters", () => {
  const { ctx, rows } = build();
  const f = (spec: Partial<K.FilterSpec>) => K.arrange(rows, { ...none, filter: { ...K.NO_FILTER, ...spec } }, ctx);
  it("shows everything by default, in project order", () => {
    expect(names(K.arrange(rows, none, ctx))).toEqual(["Earthworks", "Strip topsoil", "Bulk fill", "Pavements", "Basecourse", "Completion", "Landscaping"]);
  });
  it("keeps the summary above anything that matches", () => {
    expect(names(f({ kind: "critical" }))).toEqual(["Earthworks", "Strip topsoil", "Bulk fill", "Pavements", "Basecourse", "Completion"]);
    expect(names(f({ kind: "milestones" }))).toEqual(["Completion"]);
    expect(names(f({ kind: "summary" }))).toEqual(["Earthworks", "Pavements"]);
    expect(names(f({ kind: "complete" }))).toEqual(["Earthworks", "Strip topsoil"]);
    expect(names(f({ kind: "incomplete" }))).toEqual(["Earthworks", "Bulk fill", "Pavements", "Basecourse", "Completion", "Landscaping"]);
  });
  it("late: not finished and finished before today", () => {
    expect(names(f({ kind: "late" }))).toEqual(["Earthworks", "Bulk fill", "Pavements", "Basecourse", "Completion", "Landscaping"]); // everything not done that finished before 20/10
  });
  it("by resource, by date range and by text", () => {
    expect(names(f({ kind: "resource", resourceUid: 1 }))).toEqual(["Earthworks", "Bulk fill"]);
    expect(names(f({ kind: "dates", from: "2026-10-14", to: "2026-10-16" }))).toEqual(["Pavements", "Basecourse", "Completion"]);
    expect(names(f({ text: "fill" }))).toEqual(["Earthworks", "Bulk fill"]);
    expect(names(f({ text: "DIGGER" }))).toEqual(["Earthworks", "Bulk fill"]); // text also looks in resource names
    expect(names(f({ text: "nothing like this" }))).toEqual([]);
  });
  it("slipping: past its baseline finish", () => {
    const { p } = build();
    p.tasks[2]!.baseline = { start: "2026-10-07T08:00:00", finish: "2026-10-09T17:00:00", durationMin: 3 * D };
    const sched = G.schedule(p);
    const c: K.Ctx = { ...ctx, project: p, sched };
    const rs = p.tasks.map((task) => ({ task, s: sched.byUid.get(task.uid)! }));
    expect(names(K.arrange(rs, { ...none, filter: { ...K.NO_FILTER, kind: "slipping" } }, c))).toEqual(["Earthworks", "Bulk fill"]);
  });
});

describe("sorting and collapsing", () => {
  const { ctx, rows } = build();
  it("sorts within each summary, so the outline is kept, and either way round", () => {
    expect(names(K.arrange(rows, { ...none, sort: { key: "name", dir: "asc" } }, ctx))).toEqual(["Completion", "Earthworks", "Bulk fill", "Strip topsoil", "Landscaping", "Pavements", "Basecourse"]);
    expect(names(K.arrange(rows, { ...none, sort: { key: "duration", dir: "desc" } }, ctx))).toEqual(["Earthworks", "Bulk fill", "Strip topsoil", "Pavements", "Basecourse", "Landscaping", "Completion"]);
  });
  it("puts blanks last whichever way round, and breaks ties by ID", () => {
    const asc = names(K.arrange(rows, { ...none, sort: { key: "resources", dir: "asc" } }, ctx));
    const desc = names(K.arrange(rows, { ...none, sort: { key: "resources", dir: "desc" } }, ctx));
    expect(asc.indexOf("Bulk fill")).toBeLessThan(asc.indexOf("Strip topsoil"));
    expect(desc.indexOf("Bulk fill")).toBeLessThan(desc.indexOf("Strip topsoil"));
  });
  it("hides what is inside a collapsed summary, after sorting and filtering", () => {
    expect(names(K.arrange(rows, { ...none, collapsed: new Set([1]) }, ctx))).toEqual(["Earthworks", "Pavements", "Basecourse", "Completion", "Landscaping"]);
    const r = K.arrange(rows, { filter: { ...K.NO_FILTER, kind: "critical" }, sort: { key: "name", dir: "desc" }, collapsed: new Set([4]) }, ctx);
    expect(names(r)).toEqual(["Pavements", "Earthworks", "Strip topsoil", "Bulk fill", "Completion"]);
    expect([r.filtered, r.sorted]).toEqual([true, true]);
  });
});
