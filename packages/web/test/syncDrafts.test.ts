import { describe, expect, it } from "vitest";
import { gantt as G, splitIntoPackages, type TenderInputs } from "@blackline/tender/core";
import { editRecord, effectiveRecords, type Drafts, type ServerRecord } from "../src/lib/draft.js";
import { buildModel } from "../src/lib/model.js";
import { fromProgramme, inStep, pInfosOf } from "../src/lib/programmeSync.js";
import { syncAcross } from "../src/lib/syncDrafts.js";

const D = 480;
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
  programme: {
    start: "2026-10-05", days_per_week: 5, hours_per_day: 8,
    tasks: [
      { id: "P-00001", code: "EW01", name: "Strip", qs_code: "EW01", override_days: null, predecessors: [], hammock: false, basis: "", note: "" },
      { id: "P-00002", code: "PV01", name: "Basecourse", qs_code: "PV01", override_days: null, predecessors: ["EW01"], hammock: false, basis: "", note: "" },
    ],
  },
};

/** The job with a Gantt already built from its Programme and linked to it. */
function job(link = true) {
  const server: ServerRecord[] = splitIntoPackages(inputs).flatMap((p, i) => Object.entries(p.records).map(([id, data]) => ({ id, packageId: `pkg-${i}-${p.key}`, data: JSON.parse(JSON.stringify(data)) })));
  const m0 = buildModel(server);
  const project = { ...G.newProject("2026-10-05T08:00:00", "Roads"), progLink: link, tasks: fromProgramme(m0.programmeInfos!, D).map((r) => r.task) };
  const seed = G.ganttSeedPackage(project).records;
  const all = [...server, ...Object.entries(seed).map(([id, data]) => ({ id, packageId: "pkg-gantt", data }))];
  const programme = all.find((r) => r.id === "task:P-00001")!.packageId;
  const qs = all.find((r) => r.id === "qs:EW01")!.packageId;
  return { all, ids: { gantt: "pkg-gantt", programme }, qs };
}
const ganttTask = (records: ServerRecord[], drafts: Drafts, progId: string) => buildModel(effectiveRecords(records, drafts)).ganttRows.find((r) => r.task.progId === progId)!.task;
const progDays = (records: ServerRecord[], drafts: Drafts, id: string) => (buildModel(effectiveRecords(records, drafts)).estimate.programme as any).tasks.find((t: any) => t.id === id).duration;

describe("carrying changes between the Programme and the Gantt", () => {
  it("starts in step", () => {
    const { all } = job();
    const m = buildModel(all);
    expect(inStep(m.syncStatus)).toBe(true);
    expect(m.ganttRows.map((r) => r.task.name)).toEqual(["Earthworks", "Strip", "Pavements", "Basecourse"]);
    expect(ganttTask(all, {}, "P-00001").durationMin).toBe(7 * D); // 100 / 2 = 50 h = 6.25 days, up to 7
  });

  it("does nothing when the Gantt isn't linked", () => {
    const { all, ids } = job(false);
    const d = editRecord({}, all, ids.programme, "task:P-00001", (b) => ({ ...b, override_days: "10" }));
    const s = syncAcross(all, d, ids);
    expect(s.drafts).toBe(d);
    expect(s.notes).toEqual([]);
  });

  it("a Programme edit reaches the Gantt in the same step, and everything is then in step", () => {
    const { all, ids } = job();
    const edited = editRecord({}, all, ids.programme, "task:P-00001", (b) => ({ ...b, override_days: "10", name: "Strip and stockpile" }));
    const s = syncAcross(all, edited, ids);
    const t = ganttTask(all, s.drafts, "P-00001");
    expect([t.name, t.durationMin]).toEqual(["Strip and stockpile", 10 * D]);
    expect(s.notes[0]).toContain("from the Programme to the Gantt");
    expect(inStep(buildModel(effectiveRecords(all, s.drafts)).syncStatus)).toBe(true);
    // the later task moves with it, because the Gantt is scheduled from the links
    const sched = buildModel(effectiveRecords(all, s.drafts)).ganttSchedule!;
    expect(sched.finish).toBe("2026-10-20T17:00:00"); // 10 + 2 working days from 5 Oct
    expect(syncAcross(all, s.drafts, ids).drafts).toBe(s.drafts); // and asking again changes nothing
  });

  it("a Gantt edit reaches the Programme: a length becomes the override, a name carries, a link becomes a predecessor", () => {
    const { all, ids } = job();
    const m = buildModel(all);
    const ew = m.ganttRows.find((r) => r.task.progId === "P-00001")!.task.uid;
    let d = editRecord({}, all, ids.gantt, `gtask:${m.ganttRows.find((r) => r.task.progId === "P-00002")!.task.uid}`, (b) => ({ ...b, durationMin: 5 * D, name: "Base", links: [{ uid: ew, type: "FS", lagMin: 0 }] }));
    const s = syncAcross(all, d, ids);
    const p = buildModel(effectiveRecords(all, s.drafts)).programme!.tasks.find((t) => t.id === "P-00002")!;
    expect([p.name, p.override_days, p.predecessors]).toEqual(["Base", "5", ["EW01"]]);
    expect(progDays(all, s.drafts, "P-00002")).toBe(5);
    expect(s.notes[0]).toContain("from the Gantt to the Programme");
    d = s.drafts;
    expect(inStep(buildModel(effectiveRecords(all, d)).syncStatus)).toBe(true);
  });

  it("a change in the estimate that moves the Programme's days moves the Gantt too", () => {
    const { all, ids, qs } = job();
    const d = editRecord({}, all, qs, "qs:EW01", (b) => ({ ...b, quantity: "200" })); // twice the work: 100 h = 12.5 days, up to 13
    const s = syncAcross(all, d, ids);
    expect(progDays(all, d, "P-00001")).toBe(13);
    expect(ganttTask(all, s.drafts, "P-00001").durationMin).toBe(13 * D);
  });

  it("a Gantt edit and a Programme edit to the same thing: the Programme's wins, and it says so", () => {
    const { all, ids } = job();
    const m = buildModel(all);
    const gUid = m.ganttRows.find((r) => r.task.progId === "P-00001")!.task.uid;
    let d = editRecord({}, all, ids.programme, "task:P-00001", (b) => ({ ...b, override_days: "9" }));
    d = editRecord(d, all, ids.gantt, `gtask:${gUid}`, (b) => ({ ...b, durationMin: 4 * D }));
    const s = syncAcross(all, d, ids);
    expect(ganttTask(all, s.drafts, "P-00001").durationMin).toBe(9 * D);
    expect(s.notes.join(" ")).toContain("Programme's was kept");
  });

  it("a Programme task that is deleted takes its Gantt task out", () => {
    const { all, ids } = job();
    const d = editRecord({}, all, ids.programme, "task:P-00002", (b) => b);
    const gone: Drafts = { ...d, [ids.programme]: { ...(d[ids.programme] ?? {}), "task:P-00002": null } };
    const s = syncAcross(all, gone, ids);
    expect(buildModel(effectiveRecords(all, s.drafts)).ganttRows.map((r) => r.task.name)).toEqual(["Earthworks", "Strip", "Pavements"]);
    expect(s.notes[0]).toContain("taken out of the Gantt");
  });
});
