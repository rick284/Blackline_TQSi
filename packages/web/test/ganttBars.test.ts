import { describe, expect, it } from "vitest";
import { gantt as G } from "@blackline/tender/core";
import * as B from "../src/lib/ganttBars.js";

const D = 480;
function setup() {
  const p = G.newProject("2026-10-05T08:00:00");
  const t = (uid: number, name: string, days: number, outline = 1, links: G.Link[] = [], more: Partial<G.GTask> = {}) => p.tasks.push({ ...G.newTask(uid, name, outline), durationMin: days * D, links, ...more });
  t(1, "Summary", 0); t(2, "Long", 5, 2); t(3, "Short", 1, 2, []); t(4, "Done", 0, 1, [{ uid: 2, type: "FS", lagMin: 0 }], { milestone: true });
  const s = G.schedule(p);
  const task = (uid: number) => p.tasks.find((x) => x.uid === uid)!;
  const sch = (uid: number) => s.byUid.get(uid)!;
  return { p, task, sch };
}

describe("colours", () => {
  it("reads #rgb and #rrggbb in any case, and refuses anything else", () => {
    expect(B.normaliseHex("#ABC")).toBe("#aabbcc");
    expect(B.normaliseHex("c0392b")).toBe("#c0392b");
    expect(B.normaliseHex("  #FFFFFF ")).toBe("#ffffff");
    expect(B.normaliseHex("red")).toBeNull();
    expect(B.normaliseHex("#12345")).toBeNull();
    expect(B.normaliseHex("javascript:alert(1)")).toBeNull();
  });
  it("drops invalid fields so a damaged value can't break the chart", () => {
    expect(B.clean({ shape: "wavy" as any, fill: "pink", border: "#F00", start: "star" as any, end: "arrow" })).toEqual({ border: "#ff0000", end: "arrow" });
    expect(B.clean(null)).toEqual({});
    expect(B.clean("x" as any)).toEqual({});
  });
});

describe("which look a bar gets", () => {
  const { p, task, sch } = setup();
  it("is the usual look by kind: grey task, black critical task, black summary with end triangles, diamond milestone", () => {
    expect(B.categoryOf(task(2), sch(2), true)).toBe("critical"); // the 5-day task is on the critical path
    expect(B.categoryOf(task(3), sch(3), true)).toBe("task");
    expect(B.categoryOf(task(1), sch(1), true)).toBe("summary");
    expect(B.categoryOf(task(4), sch(4), true)).toBe("milestone");
    expect(B.categoryOf(task(2), sch(2), false)).toBe("task"); // critical shown off
    expect(B.resolve(task(3), sch(3), undefined, true)).toEqual(B.USUAL.task);
    expect(B.resolve(task(1), sch(1), undefined, true)).toMatchObject({ shape: "thin", start: "triangle", end: "triangle" });
    expect(B.resolve(task(4), sch(4), undefined, true)).toMatchObject({ start: "diamond", fill: "#000000" }); // a critical milestone is filled
    expect(B.resolve(task(4), sch(4), undefined, false)).toMatchObject({ start: "diamond", fill: "#ffffff" });
  });
  it("the project's style for the kind overrides the usual, and the task's own overrides both", () => {
    const styles = { task: { fill: "#2980b9", shape: "hatched" as const } };
    expect(B.resolve(task(3), sch(3), styles, true)).toMatchObject({ fill: "#2980b9", shape: "hatched", border: "#000000" });
    const mine = { ...task(3), bar: { fill: "#27ae60", end: "arrow" as const } };
    expect(B.resolve(mine, sch(3), styles, true)).toMatchObject({ fill: "#27ae60", shape: "hatched", end: "arrow" });
    expect(B.resolve(task(2), sch(2), styles, true).fill).toBe("#000000"); // the task style doesn't touch critical ones
  });
  it("a milestone with its own colour keeps it even when critical", () => {
    const m = { ...task(4), bar: { fill: "#c0392b" } };
    expect(B.resolve(m, sch(4), undefined, true).fill).toBe("#c0392b");
    expect(B.resolve(task(4), sch(4), { critical: { fill: "#444444" } }, true).fill).toBe("#444444");
  });
  void p;
});

describe("changing formats", () => {
  const rows = () => setup().p.tasks.map((t, i) => ({ task: t, seq: (i + 1) * 1000 }));
  it("sets a format on the selected tasks only, a field at a time, and resets it", () => {
    let r = B.setTaskBar(rows(), [2, 3], { fill: "#C0392B" });
    expect(r.map((x) => x.task.bar)).toEqual([undefined, { fill: "#c0392b" }, { fill: "#c0392b" }, undefined]);
    r = B.setTaskBar(r, [3], { shape: "outline", end: "circle" });
    expect(r[2]!.task.bar).toEqual({ fill: "#c0392b", shape: "outline", end: "circle" });
    r = B.setTaskBar(r, [3], { shape: undefined, end: undefined, fill: undefined });
    expect(r[2]!.task.bar).toBeUndefined(); // nothing left, so no format at all
    expect(B.resetTaskBar(r, [2])[1]!.task.bar).toBeUndefined();
    expect(B.setTaskBar(r, [2], { fill: "not a colour" })[1]!.task.bar).toEqual({ fill: "#c0392b" }); // a bad colour changes nothing
  });
  it("keeps the project's styles by kind, dropping a kind that is back to usual", () => {
    let s = B.setStyle(undefined, "task", { fill: "#2980b9" });
    expect(s).toEqual({ task: { fill: "#2980b9" } });
    s = B.setStyle(s, "critical", { shape: "hatched" });
    expect(s).toEqual({ task: { fill: "#2980b9" }, critical: { shape: "hatched" } });
    s = B.setStyle(s, "task", { fill: undefined });
    expect(s).toEqual({ critical: { shape: "hatched" } });
  });
  it("travels with the plan: tasks and project styles survive being stored as records", () => {
    const p = setup().p;
    p.tasks[2] = { ...p.tasks[2]!, bar: { fill: "#27ae60", shape: "thin" } };
    p.barStyles = { critical: { fill: "#c0392b" } };
    const seed = G.ganttSeedPackage(p);
    const back = G.assembleGantt(Object.entries(seed.records).map(([id, data]) => ({ id, data })))!;
    expect(back.tasks[2]!.bar).toEqual({ fill: "#27ae60", shape: "thin" });
    expect(back.barStyles).toEqual({ critical: { fill: "#c0392b" } });
    // and MS Project's file doesn't carry them (it has no such thing), but still exports and reads back the tasks
    const imported = G.importMspdi(G.exportMspdi(p));
    expect(imported.project.tasks).toHaveLength(p.tasks.length);
    expect(imported.project.tasks[2]!.bar).toBeUndefined();
  });
});
