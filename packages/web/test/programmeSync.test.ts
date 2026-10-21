import { describe, expect, it } from "vitest";
import { gantt as G } from "@blackline/tender/core";
import * as S from "../src/lib/programmeSync.js";
import type { Row } from "../src/lib/gantt.js";

const D = 480;
const base = (): S.PInfo[] => [
  { id: "P-1", code: "EW01", name: "Strip", days: 3, derived: 3, preds: [], section: "Earthworks" },
  { id: "P-2", code: "EW02", name: "Fill", days: 5, derived: 5, preds: ["EW01"], section: "Earthworks" },
  { id: "P-3", code: "PV01", name: "Basecourse", days: 2, derived: 2, preds: ["EW02"], section: "Pavements" },
];
const project = (rows: Row[]) => ({ ...G.newProject("2026-10-05T08:00:00"), tasks: rows.map((r) => r.task) });
const byProg = (rows: Row[], id: string) => rows.find((r) => r.task.progId === id)!;
const names = (rows: Row[]) => rows.map((r) => `${"-".repeat(r.task.outline - 1)}${r.task.name}`);

/** What the Programme looks like after the patches are applied to it (an override of days sets the days; none gives back the estimate's). */
function applyPatches(p: S.PInfo[], patches: Map<string, S.Patch>): S.PInfo[] {
  return p.map((x) => {
    const pt = patches.get(x.id);
    if (!pt) return x;
    return { ...x, ...(pt.name !== undefined ? { name: pt.name } : {}), ...(pt.override_days !== undefined ? { days: pt.override_days === null ? x.derived ?? 0 : Number(pt.override_days) } : {}), ...(pt.predecessors ? { preds: pt.predecessors } : {}) };
  });
}

describe("building the Gantt from the Programme", () => {
  const rows = S.fromProgramme(base(), D);
  it("makes a summary per section and a linked task per Programme task, with links and the in-step snapshot", () => {
    expect(names(rows)).toEqual(["Earthworks", "-Strip", "-Fill", "Pavements", "-Basecourse"]);
    const fill = byProg(rows, "P-2").task;
    expect(fill.durationMin).toBe(5 * D);
    expect(fill.links).toEqual([{ uid: byProg(rows, "P-1").task.uid, type: "FS", lagMin: 0 }]);
    expect(fill.progSync).toEqual({ name: "Fill", days: 5, preds: ["EW01"] });
    const s = G.schedule(project(rows));
    expect(s.finish).toBe("2026-10-16T17:00:00"); // 3 + 5 + 2 working days
    expect(s.problems).toEqual([]);
  });
  it("a Programme task with no days is a milestone", () => {
    const r = S.fromProgramme([{ id: "P-9", code: "X", name: "Handover", days: 0, derived: null, preds: [], section: "Controls" }], D);
    expect(r[1]!.task.milestone).toBe(true);
  });
  it("is in step when built, and stays in step when reconciled again", () => {
    const r = S.reconcile(base(), rows, D);
    expect([r.toGantt, r.toProgramme, r.created.length, r.removed.length, r.notes.length]).toEqual([0, 0, 0, 0, 0]);
    expect(S.inStep(S.statusOf(r))).toBe(true);
  });
});

describe("a change on one side carries to the other", () => {
  const rows = S.fromProgramme(base(), D);
  it("Programme to Gantt: a longer task, a new name, a new predecessor", () => {
    const p = base();
    p[1] = { ...p[1]!, days: 8, name: "Bulk fill" };
    p[2] = { ...p[2]!, preds: ["EW01", "EW02"] };
    const r = S.reconcile(p, rows, D);
    const fill = byProg(r.rows, "P-2").task, base_ = byProg(r.rows, "P-3").task;
    expect([fill.name, fill.durationMin]).toEqual(["Bulk fill", 8 * D]);
    expect(base_.links.map((l) => l.uid).sort()).toEqual([byProg(rows, "P-1").task.uid, byProg(rows, "P-2").task.uid].sort());
    expect(fill.progSync).toEqual({ name: "Bulk fill", days: 8, preds: ["EW01"] });
    expect(r.toGantt).toBe(2);
    expect(r.patches.size).toBe(0);
  });
  it("Gantt to Programme: a different length becomes the override, back to the estimate's clears it", () => {
    const longer = rows.map((r) => (r.task.progId === "P-2" ? { ...r, task: { ...r.task, durationMin: 6 * D } } : r));
    const r1 = S.reconcile(base(), longer, D);
    expect(r1.patches.get("P-2")).toEqual({ override_days: "6" });
    expect(byProg(r1.rows, "P-2").task.progSync!.days).toBe(6);
    const back = rows.map((r) => (r.task.progId === "P-2" ? { ...r, task: { ...r.task, durationMin: 5 * D } } : r));
    // the Programme currently has an override of 6 (days 6), derived 5: the Gantt at 5 days clears the override
    const p = base(); p[1] = { ...p[1]!, days: 6 };
    const synced = rows.map((r) => (r.task.progId === "P-2" ? { ...r, task: { ...r.task, durationMin: 6 * D, progSync: { name: "Fill", days: 6, preds: ["EW01"] } } } : r));
    const r2 = S.reconcile(p, synced.map((r) => (r.task.progId === "P-2" ? { ...r, task: { ...r.task, durationMin: 5 * D } } : r)), D);
    expect(r2.patches.get("P-2")).toEqual({ override_days: null });
    void back;
  });
  it("a part day rounds up when it goes to the Programme, and the Gantt keeps its part day", () => {
    const part = rows.map((r) => (r.task.progId === "P-1" ? { ...r, task: { ...r.task, durationMin: 2.5 * D } } : r));
    const r = S.reconcile(base(), part, D);
    expect(r.patches.size).toBe(0); // 2.5 days is 3 days to the Programme, which is what it already has
    expect(byProg(r.rows, "P-1").task.durationMin).toBe(2.5 * D);
    const longer = rows.map((x) => (x.task.progId === "P-1" ? { ...x, task: { ...x.task, durationMin: 3.5 * D } } : x));
    const r2 = S.reconcile(base(), longer, D);
    expect(r2.patches.get("P-1")).toEqual({ override_days: "4" });
    expect(byProg(r2.rows, "P-1").task.durationMin).toBe(3.5 * D); // the Gantt keeps its half day
  });
  it("Gantt to Programme: a name and a predecessor, from finish-to-start links only", () => {
    const uid1 = byProg(rows, "P-1").task.uid, uid2 = byProg(rows, "P-2").task.uid;
    const edited = rows.map((r) => (r.task.progId === "P-3" ? { ...r, task: { ...r.task, name: "Base", links: [{ uid: uid2, type: "FS" as const, lagMin: 0 }, { uid: uid1, type: "FS" as const, lagMin: 0 }, { uid: uid1, type: "SS" as const, lagMin: D }] } } : r));
    const r = S.reconcile(base(), edited, D);
    expect(r.patches.get("P-3")).toEqual({ name: "Base", predecessors: ["EW01", "EW02"] });
    expect(r.toProgramme).toBe(1);
  });
  it("links and lags the Programme can't hold stay on the Gantt side", () => {
    const uid1 = byProg(rows, "P-1").task.uid;
    const withSs = rows.map((r) => (r.task.progId === "P-3" ? { ...r, task: { ...r.task, links: [...r.task.links, { uid: uid1, type: "SS" as const, lagMin: D }] } } : r));
    const p = base(); p[2] = { ...p[2]!, preds: ["EW01", "EW02"] };
    const r = S.reconcile(p, withs(withSs), D);
    const links = byProg(r.rows, "P-3").task.links;
    expect(links.some((l) => l.type === "SS")).toBe(true); // kept
    expect(links.filter((l) => l.type === "FS")).toHaveLength(2); // and the new Programme link added
    function withs(x: Row[]) { return x; }
  });
  it("both changing the same thing differently: the Programme wins and it is reported", () => {
    const p = base(); p[1] = { ...p[1]!, days: 9 };
    const g = rows.map((r) => (r.task.progId === "P-2" ? { ...r, task: { ...r.task, durationMin: 7 * D } } : r));
    const r = S.reconcile(p, g, D);
    expect(byProg(r.rows, "P-2").task.durationMin).toBe(9 * D);
    expect(r.patches.size).toBe(0);
    expect(r.notes[0]).toContain("Programme's was kept");
    // both changing it to the same thing is no clash
    const same = rows.map((x) => (x.task.progId === "P-2" ? { ...x, task: { ...x.task, durationMin: 9 * D } } : x));
    expect(S.reconcile(p, same, D).notes).toEqual([]);
  });
  it("settles in one pass: after the changes are applied, nothing more is pending", () => {
    const p = base(); p[0] = { ...p[0]!, days: 4 };
    const g = rows.map((r) => (r.task.progId === "P-3" ? { ...r, task: { ...r.task, durationMin: 4 * D, name: "Base" } } : r));
    const r1 = S.reconcile(p, g, D);
    const r2 = S.reconcile(applyPatches(p, r1.patches), r1.rows, D);
    expect([r2.toGantt, r2.toProgramme, r2.created.length, r2.removed.length, r2.notes.length]).toEqual([0, 0, 0, 0, 0]);
    expect(byProg(r2.rows, "P-1").task.durationMin).toBe(4 * D);
    expect(applyPatches(p, r1.patches)[2]).toMatchObject({ name: "Base", days: 4 });
  });
});

describe("tasks added and taken out", () => {
  const rows = S.fromProgramme(base(), D);
  it("a new Programme task gets a Gantt task in its section, following what it follows", () => {
    const p = [...base(), { id: "P-4", code: "EW03", name: "Trim", days: 2, derived: null, preds: ["EW02"], section: "Earthworks" }, { id: "P-5", code: "CTL1", name: "Inspection", days: 1, derived: null, preds: ["PV01"], section: "Controls" }];
    const r = S.reconcile(p, rows, D);
    expect(names(r.rows)).toEqual(["Earthworks", "-Strip", "-Fill", "-Trim", "Pavements", "-Basecourse", "Controls", "-Inspection"]);
    expect(byProg(r.rows, "P-4").task.links).toEqual([{ uid: byProg(rows, "P-2").task.uid, type: "FS", lagMin: 0 }]);
    expect(r.created).toEqual(["P-4", "P-5"]);
    expect(r.rows.every((x, i) => i === 0 || x.seq > r.rows[i - 1]!.seq)).toBe(true);
    const settled = S.reconcile(p, r.rows, D);
    expect([settled.toGantt, settled.created.length, settled.removed.length]).toEqual([0, 0, 0]);
  });
  it("a Programme task that is gone takes its Gantt task, and the links to it, with it", () => {
    const p = base().filter((x) => x.id !== "P-2").map((x) => (x.id === "P-3" ? { ...x, preds: [] } : x));
    const r = S.reconcile(p, rows, D);
    expect(names(r.rows)).toEqual(["Earthworks", "-Strip", "Pavements", "-Basecourse"]);
    expect(r.removed).toEqual([byProg(rows, "P-2").task.uid]);
    expect(byProg(r.rows, "P-3").task.links).toEqual([]);
  });
  it("Gantt-only tasks are left alone, and structural changes can be held back", () => {
    const own = [...rows, { task: G.newTask(99, "Site meeting", 1), seq: 99000 }];
    const r = S.reconcile(base(), own, D);
    expect(r.rows.find((x) => x.task.uid === 99)).toBeDefined();
    const p = [...base(), { id: "P-4", code: "EW03", name: "Trim", days: 2, derived: null, preds: [], section: "Earthworks" }];
    expect(S.reconcile(p, rows, D, { structural: false }).created).toEqual([]);
  });
  it("adds Gantt tasks to the Programme as control tasks, linked, but not summaries or ones already there", () => {
    const own = [...rows, { task: { ...G.newTask(99, "Site meeting", 1), durationMin: 2.5 * D, links: [{ uid: byProg(rows, "P-3").task.uid, type: "FS" as const, lagMin: 0 }] }, seq: 99000 }];
    const progTasks: S.ProgTask[] = base().map((x) => ({ id: x.id, code: x.code, name: x.name, qs_code: "", override_days: null, predecessors: x.preds, hammock: false, basis: "", note: "" }));
    const r = S.addToProgramme(own, [99, byProg(own, "P-1").task.uid, own[0]!.task.uid], progTasks, D);
    expect(r.tasks).toHaveLength(1);
    expect(r.tasks[0]).toMatchObject({ id: "P-00001", code: "G99", name: "Site meeting", override_days: "3", predecessors: ["PV01"], qs_code: "" });
    expect(r.skipped).toHaveLength(2);
    expect(r.rows.find((x) => x.task.uid === 99)!.task).toMatchObject({ progId: "P-00001", progSync: { name: "Site meeting", days: 3, preds: ["PV01"] } });
  });
  it("taking linked Gantt tasks out names the Programme tasks to delete and fixes what followed them", () => {
    const progTasks: S.ProgTask[] = base().map((x) => ({ id: x.id, code: x.code, name: x.name, qs_code: "", override_days: null, predecessors: x.preds, hammock: false, basis: "", note: "" }));
    const r = S.removeFromProgramme(rows, [byProg(rows, "P-2").task.uid], progTasks);
    expect(r.deletes).toEqual(["P-2"]);
    expect([...r.rewrites]).toEqual([["P-3", []]]);
    expect(S.removeFromProgramme(rows, [byProg(rows, "P-2").task.uid, 12345], progTasks).deletes).toEqual(["P-2"]);
  });
});
