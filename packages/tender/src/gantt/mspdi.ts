/**
 * MSPDI: the XML format MS Project opens (File > Open) and saves (File > Save As > XML). MS Project's own .mpp is a closed binary
 * format, so this is how a Blackline programme gets into MS Project and back. Written to Microsoft's published schema (namespace
 * http://schemas.microsoft.com/project) with its element order, which MS Project is strict about when reading.
 *
 * Export carries: project properties, calendars (week days, working times, exceptions), tasks (outline, WBS, durations, dates, % complete,
 * milestone / summary flags, constraints, deadlines, notes, active flag, slack, critical flag, baseline 0), predecessor links with type and lag,
 * resources and assignments. Import reads the same by element name, in any order, so a file MS Project saved loads too.
 */
import { schedule } from "./schedule.js";
import { XmlWriter, child, kids, parseXml, textOf, type XmlNode } from "./xml.js";
import type { Baseline, CalException, ConstraintType, GAssignment, GCalendar, GProject, GResource, GTask, Link, LinkType, WorkTime } from "./types.js";
import { newProject, newTask, standardCalendar } from "./types.js";

export const MSPDI_NS = "http://schemas.microsoft.com/project";

const CONSTRAINT_CODE: Record<ConstraintType, number> = { ASAP: 0, ALAP: 1, MSO: 2, MFO: 3, SNET: 4, SNLT: 5, FNET: 6, FNLT: 7 };
const CODE_CONSTRAINT = Object.fromEntries(Object.entries(CONSTRAINT_CODE).map(([k, v]) => [v, k])) as Record<number, ConstraintType>;
/** MSPDI link types: 0 FF, 1 FS, 2 SF, 3 SS */
const LINK_CODE: Record<LinkType, number> = { FF: 0, FS: 1, SF: 2, SS: 3 };
const CODE_LINK: Record<number, LinkType> = { 0: "FF", 1: "FS", 2: "SF", 3: "SS" };
const RESOURCE_CODE = { material: 0, work: 1, cost: 2 } as const;
const CODE_RESOURCE: Record<number, GResource["type"]> = { 0: "material", 1: "work", 2: "cost" };

/** MS Project's duration format codes: 3 minutes, 5 hours, 7 days, 9 weeks, 11 months (the elapsed ones are one more). */
const DURATION_FORMAT_DAYS = 7;

const p2 = (n: number) => String(n).padStart(2, "0");
export const isoDuration = (min: number) => `PT${Math.floor(min / 60)}H${min % 60}M0S`;
export function parseIsoDuration(s: string, minutesPerDay = 480): number {
  const m = /^-?P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(s.trim());
  if (!m) return 0;
  return Math.round(Number(m[1] ?? 0) * minutesPerDay + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) + Number(m[4] ?? 0) / 60);
}
const clock = (min: number) => `${p2(Math.floor(min / 60))}:${p2(min % 60)}:00`;
const parseClock = (s: string) => { const m = /^(\d{1,2}):(\d{2})/.exec(s.trim()); return m ? Number(m[1]) * 60 + Number(m[2]) : 0; };

// ---------------------------------------------------------------------------------------------------------------------------------
export function exportMspdi(project: GProject, opts: { savedAt?: string } = {}): string {
  const s = schedule(project);
  const w = new XmlWriter().declaration().open("Project", ` xmlns="${MSPDI_NS}"`);
  const cal = project.calendars.find((c) => c.uid === project.calendarUid) ?? project.calendars[0] ?? standardCalendar();
  const first = (cal.week[2]?.times ?? [])[0];
  const last = (cal.week[2]?.times ?? []).slice(-1)[0];

  w.el("SaveVersion", 14).el("Name", `${project.name}.xml`).el("Title", project.name);
  if (opts.savedAt) w.el("CreationDate", opts.savedAt).el("LastSaved", opts.savedAt);
  w.el("ScheduleFromStart", 1).el("StartDate", s.tasks.length ? s.start : project.start).el("FinishDate", s.tasks.length ? s.finish : project.start);
  if (project.statusDate) w.el("StatusDate", project.statusDate);
  w.el("CalendarUID", cal.uid)
    .el("DefaultStartTime", clock(first?.from ?? 480)).el("DefaultFinishTime", clock(last?.to ?? 1020))
    .el("MinutesPerDay", project.minutesPerDay).el("MinutesPerWeek", project.minutesPerWeek).el("DaysPerMonth", 20)
    .el("DurationFormat", DURATION_FORMAT_DAYS).el("HonorConstraints", 1);

  w.open("Calendars");
  for (const c of project.calendars) writeCalendar(w, c);
  w.close("Calendars");

  w.open("Tasks");
  for (const t of project.tasks) {
    const r = s.byUid.get(t.uid)!;
    const summary = r.summary;
    w.open("Task");
    w.el("UID", t.uid).el("ID", r.id).el("Name", t.name).el("Active", t.active).el("Manual", 0).el("Type", 0).el("IsNull", 0);
    w.el("WBS", r.wbs).el("OutlineNumber", r.wbs).el("OutlineLevel", r.level).el("Priority", 500);
    w.el("Start", r.start).el("Finish", r.finish).el("Duration", isoDuration(r.durationMin)).el("DurationFormat", DURATION_FORMAT_DAYS);
    w.el("Milestone", t.milestone && !summary).el("Summary", summary).el("Critical", r.critical);
    w.el("FreeSlack", r.freeSlackMin * 10).el("TotalSlack", r.totalSlackMin * 10);
    w.el("PercentComplete", Math.round(r.percent)).el("PercentWorkComplete", Math.round(r.percent));
    w.el("ConstraintType", CONSTRAINT_CODE[t.constraint]);
    if (t.calendarUid !== null) w.el("CalendarUID", t.calendarUid);
    if (t.constraintDate) w.el("ConstraintDate", t.constraintDate);
    if (t.deadline) w.el("Deadline", t.deadline);
    if (t.notes) w.el("Notes", t.notes);
    for (const l of t.links) {
      w.open("PredecessorLink");
      w.el("PredecessorUID", l.uid).el("Type", LINK_CODE[l.type]).el("CrossProject", 0).el("LinkLag", l.lagMin * 10).el("LagFormat", DURATION_FORMAT_DAYS);
      w.close("PredecessorLink");
    }
    if (t.baseline) {
      w.open("Baseline");
      w.el("Number", 0).el("Start", t.baseline.start).el("Finish", t.baseline.finish).el("Duration", isoDuration(t.baseline.durationMin)).el("DurationFormat", DURATION_FORMAT_DAYS);
      w.close("Baseline");
    }
    w.close("Task");
  }
  w.close("Tasks");

  w.open("Resources");
  project.resources.forEach((r, i) => {
    w.open("Resource");
    w.el("UID", r.uid).el("ID", i + 1).el("Name", r.name).el("Type", RESOURCE_CODE[r.type]).el("IsNull", 0).el("Initials", r.initials || undefined).el("MaxUnits", r.maxUnits).el("StandardRate", r.stdRate || "0");
    w.close("Resource");
  });
  w.close("Resources");

  w.open("Assignments");
  for (const a of project.assignments) {
    w.open("Assignment");
    w.el("UID", a.uid).el("TaskUID", a.taskUid).el("ResourceUID", a.resourceUid).el("Units", a.units);
    w.close("Assignment");
  }
  w.close("Assignments");

  w.close("Project");
  return w.toString();
}

function writeCalendar(w: XmlWriter, c: GCalendar) {
  w.open("Calendar").el("UID", c.uid).el("Name", c.name).el("IsBaseCalendar", 1);
  w.open("WeekDays");
  for (let d = 1; d <= 7; d++) {
    const day = c.week[d] ?? { working: false, times: [] };
    w.open("WeekDay").el("DayType", d).el("DayWorking", day.working && day.times.length > 0);
    if (day.working && day.times.length) {
      w.open("WorkingTimes");
      for (const t of day.times) { w.open("WorkingTime").el("FromTime", clock(t.from)).el("ToTime", clock(t.to)).close("WorkingTime"); }
      w.close("WorkingTimes");
    }
    w.close("WeekDay");
  }
  w.close("WeekDays");
  if (c.exceptions.length) {
    w.open("Exceptions");
    for (const e of c.exceptions) {
      w.open("Exception").el("EnteredByOccurrences", 0);
      w.open("TimePeriod").el("FromDate", `${e.from}T00:00:00`).el("ToDate", `${e.to}T23:59:00`).close("TimePeriod");
      w.el("Occurrences", 1).el("Name", e.name || undefined).el("Type", 1).el("DayWorking", e.working);
      if (e.working && e.times.length) {
        w.open("WorkingTimes");
        for (const t of e.times) { w.open("WorkingTime").el("FromTime", clock(t.from)).el("ToTime", clock(t.to)).close("WorkingTime"); }
        w.close("WorkingTimes");
      }
      w.close("Exception");
    }
    w.close("Exceptions");
  }
  w.close("Calendar");
}

// ---------------------------------------------------------------------------------------------------------------------------------
export interface MspdiImport {
  project: GProject;
  /** Things in the file Blackline doesn't carry, so nothing is dropped silently */
  warnings: string[];
}

const num = (s: string, dflt = 0) => { const n = Number(s); return s.trim() !== "" && Number.isFinite(n) ? n : dflt; };
const flag = (s: string, dflt = false) => (s.trim() === "" ? dflt : s.trim() === "1" || s.trim().toLowerCase() === "true");

export function importMspdi(xml: string): MspdiImport {
  const root = parseXml(xml);
  if (root.name !== "Project") throw new Error("This isn't an MS Project XML file (the first element should be <Project>).");
  const warnings: string[] = [];
  const minutesPerDay = num(textOf(root, "MinutesPerDay"), 480) || 480;
  const startText = textOf(root, "StartDate");
  const p = newProject(startText || "2000-01-03T08:00:00", textOf(root, "Title") || textOf(root, "Name").replace(/\.xml$/i, "") || "Project");
  if (!startText) warnings.push("The file has no project start date; Monday 3 January 2000 was used. Set the project start.");
  p.minutesPerDay = minutesPerDay;
  p.minutesPerWeek = num(textOf(root, "MinutesPerWeek"), minutesPerDay * 5) || minutesPerDay * 5;
  p.statusDate = textOf(root, "StatusDate") || null;
  p.calendars = readCalendars(child(root, "Calendars"), warnings);
  if (p.calendars.length === 0) p.calendars = [standardCalendar()];
  const wantCal = num(textOf(root, "CalendarUID"), p.calendars[0]!.uid);
  p.calendarUid = p.calendars.some((c) => c.uid === wantCal) ? wantCal : p.calendars[0]!.uid;

  let manual = 0, percentLag = 0, extras = 0;
  for (const n of kids(child(root, "Tasks"), "Task")) {
    const level = num(textOf(n, "OutlineLevel"), 1);
    if (level === 0 || flag(textOf(n, "IsNull"))) continue; // the project summary task and empty rows
    const uid = num(textOf(n, "UID"), -1);
    if (uid < 0) continue;
    const t = newTask(uid, textOf(n, "Name") || "(no name)", Math.max(1, level));
    const summary = flag(textOf(n, "Summary"));
    t.milestone = flag(textOf(n, "Milestone"));
    t.durationMin = t.milestone ? 0 : parseIsoDuration(textOf(n, "Duration"), minutesPerDay);
    t.active = flag(textOf(n, "Active"), true);
    // a summary's duration and % complete are worked out from its children, so what the file says for it is ignored
    t.percent = summary ? 0 : Math.min(100, Math.max(0, num(textOf(n, "PercentComplete"))));
    if (summary) t.durationMin = 0;
    t.constraint = CODE_CONSTRAINT[num(textOf(n, "ConstraintType"))] ?? "ASAP";
    t.constraintDate = textOf(n, "ConstraintDate") || null;
    if (t.constraint !== "ASAP" && t.constraint !== "ALAP" && !t.constraintDate) t.constraint = "ASAP";
    t.deadline = textOf(n, "Deadline") || null;
    t.notes = textOf(n, "Notes");
    const calUid = textOf(n, "CalendarUID");
    t.calendarUid = calUid !== "" && num(calUid, -1) >= 0 && p.calendars.some((c) => c.uid === num(calUid)) ? num(calUid) : null;
    if (flag(textOf(n, "Manual"))) {
      manual++;
      // a manually scheduled task keeps its dates: hold them with a Start No Earlier Than
      const st = textOf(n, "Start");
      if (st && !summary) { t.constraint = "SNET"; t.constraintDate = st; }
    }
    for (const l of kids(n, "PredecessorLink")) {
      const puid = num(textOf(l, "PredecessorUID"), -1);
      if (puid < 0) continue;
      const fmt = num(textOf(l, "LagFormat"), 7);
      if (fmt === 19 || fmt === 20) { percentLag++; }
      const lag: Link = { uid: puid, type: CODE_LINK[num(textOf(l, "Type"), 1)] ?? "FS", lagMin: fmt === 19 || fmt === 20 ? 0 : Math.round(num(textOf(l, "LinkLag")) / 10) };
      t.links.push(lag);
    }
    for (const b of kids(n, "Baseline")) {
      if (num(textOf(b, "Number")) !== 0) { extras++; continue; }
      const bl: Baseline = { start: textOf(b, "Start"), finish: textOf(b, "Finish"), durationMin: parseIsoDuration(textOf(b, "Duration"), minutesPerDay) };
      if (bl.start && bl.finish) t.baseline = bl;
    }
    p.tasks.push(t);
  }
  if (manual) warnings.push(`${manual} manually scheduled task${manual === 1 ? "" : "s"} became automatic tasks held by a Start No Earlier Than date.`);
  if (percentLag) warnings.push(`${percentLag} link${percentLag === 1 ? "" : "s"} used a percentage lag, which Blackline doesn't carry yet; the lag was set to zero.`);
  if (extras) warnings.push("Baselines 1 to 10 were not imported (Baseline 0 was).");

  const rIds = new Set<number>();
  for (const n of kids(child(root, "Resources"), "Resource")) {
    const uid = num(textOf(n, "UID"), -1);
    const name = textOf(n, "Name");
    if (uid <= 0 || !name || flag(textOf(n, "IsNull"))) continue; // UID 0 is MS Project's unassigned placeholder
    rIds.add(uid);
    p.resources.push({ uid, name, type: CODE_RESOURCE[num(textOf(n, "Type"), 1)] ?? "work", maxUnits: num(textOf(n, "MaxUnits"), 1), stdRate: textOf(n, "StandardRate") || "0", initials: textOf(n, "Initials") });
  }
  const tIds = new Set(p.tasks.map((t) => t.uid));
  for (const n of kids(child(root, "Assignments"), "Assignment")) {
    const taskUid = num(textOf(n, "TaskUID"), -1), resourceUid = num(textOf(n, "ResourceUID"), -1);
    if (!tIds.has(taskUid) || !rIds.has(resourceUid)) continue;
    const a: GAssignment = { uid: num(textOf(n, "UID"), p.assignments.length + 1), taskUid, resourceUid, units: num(textOf(n, "Units"), 1) };
    p.assignments.push(a);
  }
  return { project: p, warnings };
}

function readCalendars(node: XmlNode | undefined, warnings: string[]): GCalendar[] {
  const raw = kids(node, "Calendar").map((n) => ({ n, uid: num(textOf(n, "UID"), -1), base: num(textOf(n, "BaseCalendarUID"), -1), isBase: flag(textOf(n, "IsBaseCalendar"), true) }));
  const done = new Map<number, GCalendar>();
  const build = (r: (typeof raw)[number]): GCalendar => {
    const hit = done.get(r.uid);
    if (hit) return hit;
    const baseRaw = r.base >= 0 && !r.isBase ? raw.find((x) => x.uid === r.base && x !== r) : undefined;
    const base = baseRaw ? build(baseRaw) : null;
    const c: GCalendar = base ? { uid: r.uid, name: textOf(r.n, "Name") || `Calendar ${r.uid}`, week: structuredClone(base.week), exceptions: structuredClone(base.exceptions) } : { uid: r.uid, name: textOf(r.n, "Name") || `Calendar ${r.uid}`, week: standardCalendar().week, exceptions: [] };
    for (const wd of kids(child(r.n, "WeekDays"), "WeekDay")) {
      const type = num(textOf(wd, "DayType"), -1);
      const working = flag(textOf(wd, "DayWorking"));
      const times: WorkTime[] = kids(child(wd, "WorkingTimes"), "WorkingTime").map((t) => ({ from: parseClock(textOf(t, "FromTime")), to: Math.max(parseClock(textOf(t, "ToTime")), 0) }));
      const fixed = times.map((t) => (t.to === 0 ? { from: t.from, to: 1440 } : t)); // "00:00" as a finish means midnight at the end of the day
      if (type >= 1 && type <= 7) c.week[type] = { working: working && fixed.length > 0, times: working ? fixed : [] };
      else if (type === 0) {
        const from = textOf(child(wd, "TimePeriod"), "FromDate").slice(0, 10), to = textOf(child(wd, "TimePeriod"), "ToDate").slice(0, 10);
        if (from && to) c.exceptions.push({ name: "", from, to, working, times: working ? fixed : [] });
      }
    }
    for (const ex of kids(child(r.n, "Exceptions"), "Exception")) {
      const from = textOf(child(ex, "TimePeriod"), "FromDate").slice(0, 10), to = textOf(child(ex, "TimePeriod"), "ToDate").slice(0, 10);
      if (!from || !to) continue;
      if (num(textOf(ex, "Occurrences"), 1) > 1 || num(textOf(ex, "Type"), 1) !== 1) { warnings.push(`The calendar "${c.name}" has a recurring exception ("${textOf(ex, "Name")}") that Blackline doesn't carry yet; it was skipped.`); continue; }
      const working = flag(textOf(ex, "DayWorking"));
      const times = kids(child(ex, "WorkingTimes"), "WorkingTime").map((t) => ({ from: parseClock(textOf(t, "FromTime")), to: parseClock(textOf(t, "ToTime")) || 1440 }));
      c.exceptions.push({ name: textOf(ex, "Name"), from, to, working, times: working ? times : [] } satisfies CalException);
    }
    done.set(r.uid, c);
    return c;
  };
  return raw.filter((r) => r.uid >= 0).map(build);
}
