import { describe, expect, it } from "vitest";
import { gantt as G } from "@blackline/tender/core";
import * as R from "../src/lib/ganttResources.js";

const D = 480;
function project(): G.GProject {
  const p = G.newProject("2026-10-05T08:00:00");
  const t = (uid: number, name: string, days: number, outline = 1, links: G.Link[] = []) => { const x = G.newTask(uid, name, outline); x.durationMin = days * D; x.links = links; p.tasks.push(x); };
  t(1, "Earthworks", 0); t(2, "Strip", 2, 2); t(3, "Fill", 3, 2, [{ uid: 2, type: "FS", lagMin: 0 }]); t(4, "Pave", 1, 1, [{ uid: 3, type: "FS", lagMin: 0 }]);
  p.resources.push({ uid: 1, name: "Digger", type: "work", maxUnits: 1, stdRate: "100", initials: "DG" }, { uid: 2, name: "Concrete", type: "material", maxUnits: 1, stdRate: "300", initials: "CO" });
  return p;
}

describe("resources", () => {
  const all = project().resources;
  it("adds a resource with a unique name, and refuses names that would break the Resource Names column", () => {
    expect(R.newResource("Labourer", all)).toMatchObject({ ok: true, body: { uid: 3, name: "Labourer", type: "work", maxUnits: 1, initials: "LA" } });
    expect(R.newResource("digger", all)).toMatchObject({ ok: false, error: expect.stringContaining("already") });
    expect(R.newResource("A, B", all)).toMatchObject({ ok: false });
    expect(R.newResource("  ", all)).toMatchObject({ ok: false });
  });
  it("reads units and rates as people type them", () => {
    expect([R.parseUnits("50%"), R.parseUnits("100"), R.parseUnits("250 %"), R.parseUnits("12.5")]).toEqual([0.5, 1, 2.5, 0.125]);
    expect(R.parseUnits("lots")).toBeNull();
    expect(R.formatUnits(0.5)).toBe("50%");
    const d = all[0]!;
    expect(R.setResourceField(d, "maxUnits", "200%", all)).toMatchObject({ ok: true, body: { maxUnits: 2 } });
    expect(R.setResourceField(d, "stdRate", "$95.50/hr", all)).toMatchObject({ ok: true, body: { stdRate: "95.5" } });
    expect(R.setResourceField(d, "stdRate", "cheap", all)).toMatchObject({ ok: false });
    expect(R.setResourceField(d, "type", "material", all)).toMatchObject({ ok: true, body: { type: "material" } });
    expect(R.setResourceField(d, "type", "robot", all)).toMatchObject({ ok: false });
    expect(R.setResourceField(d, "name", "Concrete", all)).toMatchObject({ ok: false });
    expect(R.setResourceField(d, "name", "Digger", all)).toMatchObject({ ok: true }); // its own name is fine
    expect(d.maxUnits).toBe(1);
  });
});

describe("assignments as text", () => {
  const p = project();
  it("parses names with units, and says what is wrong", () => {
    expect(R.parseAssignments("Digger, Labourer[50%], Concrete[12]", p.resources)).toEqual({ ok: true, wanted: [{ name: "Digger", units: 1 }, { name: "Labourer", units: 0.5 }, { name: "Concrete", units: 12 }] });
    expect(R.parseAssignments("", p.resources)).toEqual({ ok: true, wanted: [] });
    expect(R.parseAssignments("Digger, digger", p.resources)).toMatchObject({ ok: false, error: expect.stringContaining("twice") });
    expect(R.parseAssignments("Digger[lots]", p.resources)).toMatchObject({ ok: false });
    expect(R.parseAssignments("Concrete[some]", p.resources)).toMatchObject({ ok: false, error: expect.stringContaining("quantity") });
    expect(R.parseAssignments("Digger[0%]", p.resources)).toMatchObject({ ok: false });
  });
  it("makes a new resource for a name it hasn't seen, and keeps, changes and drops assignments", () => {
    const a1 = R.assign(p, 2, [{ name: "Digger", units: 1 }, { name: "Labourer", units: 0.5 }]);
    expect(a1.resources.map((r) => r.name)).toEqual(["Labourer"]);
    expect(a1.upserts.map((a) => [a.taskUid, a.resourceUid, a.units])).toEqual([[2, 1, 1], [2, 3, 0.5]]);
    const q = { ...p, resources: [...p.resources, ...a1.resources], assignments: a1.upserts };
    expect(R.formatAssignments(2, q)).toBe("Digger, Labourer[50%]");
    const a2 = R.assign(q, 2, [{ name: "Labourer", units: 1 }]);
    expect(a2.deletes).toEqual([1]); // Digger dropped
    expect(a2.upserts.map((a) => [a.uid, a.units])).toEqual([[2, 1]]); // Labourer changed 50% -> 100%
    expect(a2.resources).toEqual([]);
    expect(R.assign(q, 2, [{ name: "Digger", units: 1 }, { name: "Labourer", units: 0.5 }])).toEqual({ resources: [], upserts: [], deletes: [] }); // nothing changed
  });
});

describe("work and cost", () => {
  const p = project();
  p.assignments.push({ uid: 1, taskUid: 2, resourceUid: 1, units: 1 }, { uid: 2, taskUid: 3, resourceUid: 1, units: 0.5 }, { uid: 3, taskUid: 3, resourceUid: 2, units: 10 });
  const s = G.schedule(p);
  it("works out each task's work and cost, and adds them up under summaries", () => {
    const t = R.taskTotals(p, s);
    expect(t.get(2)).toEqual({ workMin: 2 * D, cost: 1600 }); // 16 h x $100
    expect(t.get(3)).toEqual({ workMin: 3 * D / 2, cost: 3 * 8 * 0.5 * 100 + 10 * 300 }); // 12 h x $100 + 10 x $300 material
    expect(t.get(1)).toEqual({ workMin: 2 * D + 3 * D / 2, cost: 1600 + 1200 + 3000 });
    expect(t.get(4)).toEqual({ workMin: 0, cost: 0 });
  });
  it("per resource: work, cost, tasks, peak units, and over-allocation", () => {
    const u = R.resourceUse(p, s);
    expect(u.get(1)).toMatchObject({ workMin: 2 * D + 3 * D / 2, cost: 2800, tasks: 2, peak: 1, over: false });
    expect(u.get(2)).toMatchObject({ cost: 3000, tasks: 1, peak: 0, over: false });
    // a second task for the Digger at the same time as Strip puts it over 100%
    const q = { ...p, assignments: [...p.assignments, { uid: 4, taskUid: 4, resourceUid: 1, units: 1 }] };
    q.tasks = q.tasks.map((t) => (t.uid === 4 ? { ...t, links: [], durationMin: 5 * D } : t)); // Pave now runs from the start, alongside Strip
    const over = R.resourceUse(q, G.schedule(q)).get(1)!;
    expect(over.peak).toBe(2);
    expect(over.over).toBe(true);
  });
  it("leaves out tasks that are switched off", () => {
    const q = { ...p, tasks: p.tasks.map((t) => (t.uid === 2 ? { ...t, active: false } : t)) };
    expect(R.resourceUse(q, G.schedule(q)).get(1)!.tasks).toBe(1);
  });
});
