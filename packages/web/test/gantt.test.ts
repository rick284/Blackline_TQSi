import { describe, expect, it } from "vitest";
import { gantt as G } from "@blackline/tender/core";
import * as X from "../src/lib/gantt.js";

const D = 480;
const rows = (spec: [string, number][]): X.Row[] => spec.map(([name, outline], i) => ({ task: G.newTask(i + 1, name, outline), seq: (i + 1) * 1000 }));
const names = (r: X.Row[]) => r.map((x) => `${"-".repeat(x.task.outline - 1)}${x.task.name}`);
const proj = (r: X.Row[]) => ({ ...G.newProject("2026-10-05T08:00:00"), tasks: r.map((x) => x.task) });

describe("insert and delete", () => {
  const base = () => rows([["A", 1], ["B", 2], ["C", 2], ["D", 1]]);
  it("inserts a task above the selected one, at its level, with a seq between its neighbours", () => {
    const { rows: r, uid } = X.insert(base(), [3], "task");
    expect(names(r)).toEqual(["A", "-B", "-New task", "-C", "D"]);
    expect(uid).toBe(5);
    expect(r[2]!.seq).toBeGreaterThan(r[1]!.seq);
    expect(r[2]!.seq).toBeLessThan(r[3]!.seq);
  });
  it("appends when nothing is selected, and makes a milestone with no duration", () => {
    const { rows: r } = X.insert(base(), [], "milestone");
    expect(names(r).slice(-1)).toEqual(["New milestone"]);
    expect(r[4]!.task.milestone).toBe(true);
    expect(r[4]!.task.durationMin).toBe(0);
  });
  it("a new summary takes the selected tasks in under it", () => {
    const { rows: r } = X.insert(base(), [2, 3], "summary");
    expect(names(r)).toEqual(["A", "-New summary task", "--B", "--C", "D"]);
  });
  it("deleting a summary deletes what is inside it, and links to the deleted tasks", () => {
    const r0 = base();
    r0[3]!.task.links = [{ uid: 2, type: "FS", lagMin: 0 }, { uid: 3, type: "FS", lagMin: 0 }];
    const { rows: r, removed } = X.remove(r0, [1]);
    expect(names(r)).toEqual(["D"]);
    expect(removed.sort()).toEqual([1, 2, 3]);
    expect(r[0]!.task.links).toEqual([]);
  });
  it("deleting a lone task leaves a link-free neighbour untouched", () => {
    const r0 = base();
    r0[2]!.task.links = [{ uid: 2, type: "FS", lagMin: 0 }];
    const { rows: r } = X.remove(r0, [4]);
    expect(r[2]!.task.links).toHaveLength(1);
    expect(names(r)).toEqual(["A", "-B", "-C"]);
  });
});

describe("outline", () => {
  it("indents a task under the one above, with what is inside it, but not two levels under", () => {
    const r = rows([["A", 1], ["B", 1], ["C", 2], ["D", 1]]);
    expect(names(X.indent(r, [2]))).toEqual(["A", "-B", "--C", "D"]);
    expect(names(X.indent(r, [4]))).toEqual(["A", "B", "-C", "-D"]);
    expect(names(X.indent(r, [3]))).toEqual(["A", "B", "-C", "D"]); // C is already one under B: it could only go to 3 under a task at 2
    expect(names(X.indent(r, [1]))).toEqual(["A", "B", "-C", "D"]); // nothing above A
  });
  it("outdents, and never past the top", () => {
    const r = rows([["A", 1], ["B", 2], ["C", 3]]);
    expect(names(X.outdent(r, [2]))).toEqual(["A", "B", "-C"]);
    expect(names(X.outdent(r, [1]))).toEqual(["A", "-B", "--C"]);
  });
});

describe("move", () => {
  const r = () => rows([["A", 1], ["A1", 2], ["B", 1], ["B1", 2], ["B2", 2], ["C", 1]]);
  it("moves a block up past the sibling above, children and all", () => {
    const out = X.move(r(), [3], -1);
    expect(names(out)).toEqual(["B", "-B1", "-B2", "A", "-A1", "C"]);
    expect(out.every((x, i) => i === 0 || x.seq > out[i - 1]!.seq)).toBe(true);
  });
  it("moves a block down past the sibling below", () => {
    expect(names(X.move(r(), [1], 1))).toEqual(["B", "-B1", "-B2", "A", "-A1", "C"]);
  });
  it("does nothing at the edge of a group, and only rewrites the rows that moved", () => {
    expect(names(X.move(r(), [1], -1))).toEqual(names(r()));
    expect(names(X.move(r(), [6], 1))).toEqual(names(r()));
    expect(names(X.move(r(), [5], 1))).toEqual(names(r())); // last child of B
    const before = r();
    const d = X.diff(before, X.move(before, [6], -1));
    expect(d.upserts.map((u) => u.task.name)).toEqual(["C"]);
    expect(d.deletes).toEqual([]);
  });
});

describe("links", () => {
  const r = () => rows([["A", 1], ["B", 1], ["C", 1]]);
  it("links the selected tasks in order, finish to start", () => {
    const out = X.linkTasks(r(), [1, 2, 3]);
    expect(out.added).toBe(2);
    expect(out.rows[1]!.task.links).toEqual([{ uid: 1, type: "FS", lagMin: 0 }]);
    expect(out.rows[2]!.task.links).toEqual([{ uid: 2, type: "FS", lagMin: 0 }]);
  });
  it("won't make a duplicate, a self-link or a loop, and says why", () => {
    const linked = X.linkTasks(r(), [1, 2, 3]).rows;
    expect(X.addLink(linked, 1, 2).skipped[0]).toContain("already follows");
    expect(X.addLink(linked, 2, 2).skipped[0]).toContain("itself");
    const loop = X.addLink(linked, 3, 1);
    expect(loop.added).toBe(0);
    expect(loop.skipped[0]).toContain("loop");
  });
  it("unlinks: one task loses its predecessors; several lose the links between them", () => {
    const linked = X.linkTasks(r(), [1, 2, 3]).rows;
    expect(X.unlinkTasks(linked, [2])[1]!.task.links).toEqual([]);
    expect(X.unlinkTasks(linked, [2])[2]!.task.links).toHaveLength(1);
    const two = X.unlinkTasks(linked, [2, 3]);
    expect(two[2]!.task.links).toEqual([]);
    expect(two[1]!.task.links).toHaveLength(1);
  });
});

describe("progress and baseline", () => {
  it("marks complete, switches tasks off, and sets and clears a baseline from the schedule", () => {
    const r = rows([["A", 1], ["B", 1]]);
    r[0]!.task.durationMin = 2 * D;
    expect(X.setPercent(r, [1], 75)[0]!.task.percent).toBe(75);
    expect(X.setPercent(r, [1], 250)[0]!.task.percent).toBe(100);
    expect(X.setActive(r, [2], false)[1]!.task.active).toBe(false);
    const withBase = X.setBaseline(r, G.schedule(proj(r)));
    expect(withBase[0]!.task.baseline).toEqual({ start: "2026-10-05T08:00:00", finish: "2026-10-06T17:00:00", durationMin: 2 * D });
    expect(X.clearBaseline(withBase)[0]!.task.baseline).toBeNull();
    expect(X.diff(r, withBase).upserts).toHaveLength(2);
  });
});

describe("what people type", () => {
  it("reads durations the way MS Project does", () => {
    expect(X.parseDuration("5")).toBe(2400);
    expect(X.parseDuration("5d")).toBe(2400);
    expect(X.parseDuration("1.5 days")).toBe(720);
    expect(X.parseDuration("3h")).toBe(180);
    expect(X.parseDuration("2w")).toBe(4800);
    expect(X.parseDuration("90m")).toBe(90);
    expect(X.parseDuration("0")).toBe(0);
    expect(X.parseDuration("soon")).toBeNull();
    expect(X.parseDuration("5 fortnights")).toBeNull();
  });
  it("shows them the way MS Project does", () => {
    expect(X.formatDuration(2400)).toBe("5 days");
    expect(X.formatDuration(480)).toBe("1 day");
    expect(X.formatDuration(0)).toBe("0 days");
    expect(X.formatDuration(240)).toBe("4 hrs");
    expect(X.formatDuration(720)).toBe("1.5 days");
  });
  it("reads dates day first, as in NZ", () => {
    expect(X.parseDate("2026-10-05")).toBe("2026-10-05T08:00:00");
    expect(X.parseDate("5/10/2026")).toBe("2026-10-05T08:00:00");
    expect(X.parseDate("5/10/26", "17:00:00")).toBe("2026-10-05T17:00:00");
    expect(X.parseDate("Mon 5 Oct 2026")).toBe("2026-10-05T08:00:00");
    expect(X.parseDate("5/10/26 1:30 pm")).toBe("2026-10-05T13:30:00");
    expect(X.parseDate("31/02/2026")).toBeNull();
    expect(X.parseDate("tomorrow")).toBeNull();
    expect(X.formatDate("2026-10-05T08:00:00")).toBe("Mon 5/10/26");
    expect(X.formatDate("2026-10-05T13:30:00", true)).toBe("Mon 5/10/26 13:30");
  });
  it("writes and reads predecessors by task number, with type and lag", () => {
    const ids: Record<number, number> = { 10: 1, 20: 2, 30: 3 };
    const text = X.formatLinks([{ uid: 10, type: "FS", lagMin: 0 }, { uid: 20, type: "SS", lagMin: D }, { uid: 30, type: "FF", lagMin: -240 }], (u) => ids[u]);
    expect(text).toBe("1, 2SS+1d, 3FF-4h");
    const back = X.parseLinks("1, 2SS+1d, 3FF-4h", (id) => [undefined, 10, 20, 30][id], 99);
    expect(back).toEqual({ ok: true, links: [{ uid: 10, type: "FS", lagMin: 0 }, { uid: 20, type: "SS", lagMin: D }, { uid: 30, type: "FF", lagMin: -240 }] });
    expect(X.parseLinks("", () => undefined, 1)).toEqual({ ok: true, links: [] });
    expect(X.parseLinks("7", () => undefined, 1)).toMatchObject({ ok: false, error: "There is no task 7." });
    expect(X.parseLinks("2", (i) => i, 2)).toMatchObject({ ok: false, error: expect.stringContaining("itself") });
    expect(X.parseLinks("two", (i) => i, 9)).toMatchObject({ ok: false });
    expect(X.parseLinks("1XX", (i) => i, 9)).toMatchObject({ ok: false });
    expect(X.parseLinks("1, 1", (i) => i, 9)).toMatchObject({ ok: false, error: expect.stringContaining("twice") });
  });
});
