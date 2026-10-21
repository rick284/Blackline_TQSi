/**
 * The Gantt as records, so it is checked out, edited, checked in and parked like every other package. One package, "Gantt", holds:
 *   gantt:config   the project (name, start, status date, default calendar, minutes per day / week)
 *   gcal:<uid>     a calendar          gtask:<uid>   a task, in row order by `seq`
 *   gres:<uid>     a resource          gasg:<uid>    an assignment
 */
import type { RecordData, SeedPackage } from "../packaging.js";
import type { GAssignment, GCalendar, GProject, GResource, GTask } from "./types.js";

export const GANTT_KEY = "gantt";
export const GANTT_NAME = "Gantt";

const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** The package a project is stored as. */
export function ganttSeedPackage(p: GProject): SeedPackage {
  const records: Record<string, RecordData> = {};
  records["gantt:config"] = { kind: "ganttConfig", body: { name: p.name, start: p.start, statusDate: p.statusDate, calendarUid: p.calendarUid, minutesPerDay: p.minutesPerDay, minutesPerWeek: p.minutesPerWeek } };
  for (const c of p.calendars) records[`gcal:${c.uid}`] = { kind: "ganttCalendar", body: plain(c) };
  p.tasks.forEach((t, i) => { records[`gtask:${t.uid}`] = { kind: "ganttTask", seq: (i + 1) * 1000, body: plain(t) }; });
  for (const r of p.resources) records[`gres:${r.uid}`] = { kind: "ganttResource", body: plain(r) };
  for (const a of p.assignments) records[`gasg:${a.uid}`] = { kind: "ganttAssignment", body: plain(a) };
  return { key: GANTT_KEY, name: GANTT_NAME, kind: "gantt", records };
}

/** The project the records describe, or null when the job has no Gantt yet. */
export function assembleGantt(records: Iterable<{ id: string; data: RecordData }>): GProject | null {
  let config: Record<string, any> | null = null;
  const tasks: { seq: number; body: GTask }[] = [];
  const calendars: GCalendar[] = [];
  const resources: GResource[] = [];
  const assignments: GAssignment[] = [];
  for (const { data } of records) {
    switch (data.kind) {
      case "ganttConfig": config = data.body as Record<string, any>; break;
      case "ganttTask": tasks.push({ seq: data.seq ?? 0, body: data.body as GTask }); break;
      case "ganttCalendar": calendars.push(data.body as GCalendar); break;
      case "ganttResource": resources.push(data.body as GResource); break;
      case "ganttAssignment": assignments.push(data.body as GAssignment); break;
    }
  }
  if (!config) return null;
  tasks.sort((a, b) => a.seq - b.seq);
  return {
    name: String(config.name ?? "Project"), start: String(config.start), statusDate: config.statusDate ?? null, calendarUid: Number(config.calendarUid ?? 1),
    minutesPerDay: Number(config.minutesPerDay ?? 480), minutesPerWeek: Number(config.minutesPerWeek ?? 2400),
    tasks: tasks.map((t) => t.body), calendars: calendars.sort((a, b) => a.uid - b.uid), resources: resources.sort((a, b) => a.uid - b.uid), assignments: assignments.sort((a, b) => a.uid - b.uid),
  };
}
