import { describe, expect, it } from "vitest";
import { D } from "@blackline/engine";
import { gantt as G, splitIntoPackages, type ProgrammeTask, type TenderInputs } from "@blackline/tender/core";
import { addRecord, editRecord, effectiveRecords, type ServerRecord } from "../src/lib/draft.js";
import { buildModel } from "../src/lib/model.js";
import { newTask, nextTaskId, setConfigField, setTaskFieldEdit, startFromEstimate } from "../src/lib/programme.js";

const task = (id: string, code: string, preds: string[] = [], over: string | null = null): ProgrammeTask =>
  ({ id, code, name: code, qs_code: "", override_days: over, predecessors: preds, hammock: false, basis: "", note: "" });

describe("programme edits", () => {
  const all = [task("P-00001", "A"), task("P-00002", "B", ["A"])];
  it("takes whole-day overrides and predecessor codes, and says what is wrong otherwise", () => {
    expect(setTaskFieldEdit(all[1]!, "override_days", "7", all)).toMatchObject({ ok: true, body: { override_days: "7" } });
    expect(setTaskFieldEdit(all[1]!, "override_days", "", all)).toMatchObject({ ok: true, body: { override_days: null } });
    expect(setTaskFieldEdit(all[1]!, "override_days", "2.5", all)).toMatchObject({ ok: false, error: expect.stringContaining("whole number") });
    expect(setTaskFieldEdit(all[1]!, "predecessors", "A, C", all)).toMatchObject({ ok: true, body: { predecessors: ["A", "C"] } });
    expect(setTaskFieldEdit(all[1]!, "predecessors", "B", all)).toMatchObject({ ok: false, error: expect.stringContaining("itself") });
    expect(setTaskFieldEdit(all[1]!, "code", "A", all)).toMatchObject({ ok: false, error: expect.stringContaining("already used") });
    expect(setTaskFieldEdit(all[1]!, "hammock", true, all)).toMatchObject({ ok: true, body: { hammock: true } });
    expect(all[1]!.override_days).toBeNull(); // the original is never touched
  });
  it("sets the start, days a week and hours a day within range", () => {
    const c = { start: "2026-10-01", days_per_week: 5, hours_per_day: 8 };
    expect(setConfigField(c, "start", "2026-11-02")).toMatchObject({ ok: true, body: { start: "2026-11-02" } });
    expect(setConfigField(c, "start", "2026-02-31")).toMatchObject({ ok: false });
    expect(setConfigField(c, "days_per_week", "6")).toMatchObject({ ok: true, body: { days_per_week: 6 } });
    expect(setConfigField(c, "days_per_week", "9")).toMatchObject({ ok: false });
    expect(setConfigField(c, "hours_per_day", "x")).toMatchObject({ ok: false });
  });
  it("adds a task from its code, with the next free id", () => {
    expect(nextTaskId(["P-00001", "P-00003"])).toBe("P-00002");
    const r = newTask("PRG-RF01", all, 9);
    expect(r).toMatchObject({ ok: true, recordId: "task:P-00003" });
    expect(newTask("A", all, 9)).toMatchObject({ ok: false, error: expect.stringContaining("already used") });
    expect(newTask("bad code!", all, 9)).toMatchObject({ ok: false });
  });
  it("starts a programme from the QS items that carry cost", () => {
    const s = startFromEstimate([{ code: "EW01", description: "Strip", amount: new D(5) }, { code: "EW02", description: "Reference only", amount: new D(0) }, { code: "PV01", description: "Basecourse", amount: new D(9) }], "2026-10-05");
    expect(s.tasks.map((t) => (t.data.body as ProgrammeTask).code)).toEqual(["EW01", "PV01"]);
    expect(s.config.body).toEqual({ start: "2026-10-05", days_per_week: 5, hours_per_day: 8 });
  });
});

describe("programme and Gantt in the job model", () => {
  const inputs: TenderInputs = {
    library: [{ code: "LAB", category: "Labour", description: "Labourer", unit: "hr", baseRate: "50" }],
    qs: [{ code: "EW01", section: "Earthworks", description: "Strip", unit: "m2", quantity: "100" }, { code: "PV01", section: "Pavements", description: "Basecourse", unit: "m2", quantity: "100" }],
    rows: [
      { qsCode: "EW01", mode: "Time x Count", resourceType: "Labour", resourceCode: "LAB", productivityRate: "2", count: "1", verified: "Yes", uid: "EW01-001" },
      { qsCode: "PV01", mode: "Time x Count", resourceType: "Labour", resourceCode: "LAB", productivityRate: "10", count: "1", verified: "Yes", uid: "PV01-001" },
    ],
    weatherLinks: { dailyUid: "", hoursPerDay: 8, weeklyUids: [] },
    tool: { exposedPool: 0, rainWetGroundCost: 0, criticalPathDelayWd: 0, additionalBilledWeeks: 0 },
    commercial: [], overlays: [], overlap: "0", reference: null,
    programme: { start: "2026-10-05", days_per_week: 5, hours_per_day: 8, tasks: [{ ...task("P-00001", "EW01"), qs_code: "EW01" }, { ...task("P-00002", "PV01", ["EW01"]), qs_code: "PV01" }] },
  };
  const server: ServerRecord[] = splitIntoPackages(inputs).flatMap((p, i) => Object.entries(p.records).map(([id, data]) => ({ id, packageId: `pkg-${i}-${p.key}`, data: JSON.parse(JSON.stringify(data)) })));

  it("works the tender programme out from the estimate, and moves it when a task is overridden", () => {
    const m = buildModel(effectiveRecords(server, {}));
    const p = m.estimate.programme as any;
    expect([p.duration, p.tasks.map((t: any) => t.duration)]).toEqual([9, [7, 2]]); // 100 / 2 = 50 h = 6.25 days, up to 7; then 100 / 10 = 10 h, up to 2
    const pkg = server.find((r) => r.id === "task:P-00001")!.packageId;
    const d = editRecord({}, server, pkg, "task:P-00001", (b) => { const r = setTaskFieldEdit(b, "override_days", "10", []); if (!r.ok) throw new Error(r.error); return r.body; });
    expect((buildModel(effectiveRecords(server, d)).estimate.programme as any).duration).toBe(12); // 10 days (override) + 2
  });

  it("has no Gantt until one is started, then shows the tasks added to it", () => {
    expect(buildModel(effectiveRecords(server, {})).gantt).toBeNull();
    const seed = G.ganttSeedPackage(G.newProject("2026-10-05T08:00:00", "Roads"));
    const withGantt: ServerRecord[] = [...server, ...Object.entries(seed.records).map(([id, data]) => ({ id, packageId: "pkg-gantt", data }))];
    const m0 = buildModel(effectiveRecords(withGantt, {}));
    expect([m0.gantt!.name, m0.ganttPackageId, m0.ganttRows.length, m0.ganttSchedule!.tasks.length]).toEqual(["Roads", "pkg-gantt", 0, 0]);
    const t = G.newTask(1, "Strip", 1); t.durationMin = 3 * 480;
    const d = addRecord({}, "pkg-gantt", "gtask:1", { kind: "ganttTask", seq: 1000, body: t });
    const m1 = buildModel(effectiveRecords(withGantt, d));
    expect(m1.ganttSchedule!.byUid.get(1)!.finish).toBe("2026-10-07T17:00:00");
    expect(m1.ganttRecordIds.sort()).toEqual(["gantt:config", "gcal:1", "gtask:1"]);
  });
});
