import { describe, expect, it } from "vitest";
import { exportMspdi, importMspdi, isoDuration, parseIsoDuration } from "../src/gantt/mspdi.js";
import { schedule } from "../src/gantt/schedule.js";
import { newProject, newTask, type GProject } from "../src/gantt/types.js";
import { child, kids, parseXml } from "../src/gantt/xml.js";

const D = 480;

function sample(): GProject {
  const p = newProject("2026-10-05T08:00:00", "Hobsonville <civil> & roads");
  p.calendars[0]!.exceptions.push({ name: "Labour Day", from: "2026-10-26", to: "2026-10-26", working: false, times: [] });
  p.calendars[0]!.exceptions.push({ name: "Saturday catch-up", from: "2026-10-17", to: "2026-10-17", working: true, times: [{ from: 480, to: 720 }] });
  const t = (uid: number, name: string, days: number, outline = 1) => { const x = newTask(uid, name, outline); x.durationMin = days * D; p.tasks.push(x); return x; };
  const s = t(1, "Site works", 0);
  const a = t(2, "Strip & stockpile", 3, 2);
  const b = t(3, 'Bulk fill "Stage 1"', 5, 2);
  b.links = [{ uid: 2, type: "FS", lagMin: D }];
  const c = t(4, "Drainage", 4, 2);
  c.links = [{ uid: 2, type: "SS", lagMin: 240 }, { uid: 3, type: "FF", lagMin: -D }];
  c.constraint = "SNET"; c.constraintDate = "2026-10-08T08:00:00";
  c.deadline = "2026-11-30T17:00:00";
  c.notes = "Allied to confirm <CCTV> scope";
  c.percent = 40;
  const m = t(5, "Practical completion", 0);
  m.milestone = true; m.links = [{ uid: 3, type: "FS", lagMin: 0 }, { uid: 4, type: "FS", lagMin: 0 }];
  m.baseline = { start: "2026-10-30T17:00:00", finish: "2026-10-30T17:00:00", durationMin: 0 };
  a.baseline = { start: "2026-10-05T08:00:00", finish: "2026-10-07T17:00:00", durationMin: 3 * D };
  void s;
  p.resources.push({ uid: 1, name: "Civil gang", type: "work", maxUnits: 2, stdRate: "95", initials: "CG" });
  p.assignments.push({ uid: 1, taskUid: 2, resourceUid: 1, units: 1 });
  return p;
}

describe("durations", () => {
  it("writes hours the way MS Project does and reads them back", () => {
    expect(isoDuration(480)).toBe("PT8H0M0S");
    expect(isoDuration(90)).toBe("PT1H30M0S");
    expect(isoDuration(0)).toBe("PT0H0M0S");
    expect(parseIsoDuration("PT40H0M0S")).toBe(2400);
    expect(parseIsoDuration("PT1H30M0S")).toBe(90);
    expect(parseIsoDuration("P2D", 480)).toBe(960);
    expect(parseIsoDuration("nonsense")).toBe(0);
  });
});

describe("xml reader", () => {
  it("reads nested elements, entities, CDATA, comments and namespaces", () => {
    const n = parseXml('<?xml version="1.0"?><!-- hi --><p:Project xmlns:p="x"><p:Name>A &amp; B &lt;c&gt; &#65;</p:Name><p:Notes><![CDATA[<raw> & text]]></p:Notes><p:Empty/><p:Kid a="1 > 0"><p:Deep>1</p:Deep></p:Kid></p:Project>');
    expect(n.name).toBe("Project");
    expect(child(n, "Name")!.text).toBe("A & B <c> A");
    expect(child(n, "Notes")!.text).toBe("<raw> & text");
    expect(child(n, "Empty")).toBeDefined();
    expect(child(child(n, "Kid"), "Deep")!.text).toBe("1");
  });
  it("says what is wrong with broken XML", () => {
    expect(() => parseXml("<a><b></a>")).toThrow(/closes <a>/);
    expect(() => parseXml("<a><b>")).toThrow(/missing the end/);
    expect(() => parseXml("")).toThrow(/no XML/);
  });
});

describe("MSPDI export", () => {
  const xml = exportMspdi(sample());
  const root = parseXml(xml);

  it("is a Project in Microsoft's namespace, in the element order MS Project reads", () => {
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>')).toBe(true);
    expect(xml).toContain('<Project xmlns="http://schemas.microsoft.com/project">');
    const order = ["SaveVersion", "Name", "Title", "ScheduleFromStart", "StartDate", "FinishDate", "CalendarUID", "DefaultStartTime", "DefaultFinishTime", "MinutesPerDay", "MinutesPerWeek", "DaysPerMonth", "DurationFormat", "HonorConstraints", "Calendars", "Tasks", "Resources", "Assignments"];
    const got = root.children.map((c) => c.name);
    expect(got).toEqual(order);
  });

  it("writes each task's elements in schema order", () => {
    const canonical = ["UID", "ID", "Name", "Active", "Manual", "Type", "IsNull", "WBS", "OutlineNumber", "OutlineLevel", "Priority", "Start", "Finish", "Duration", "DurationFormat", "Milestone", "Summary", "Critical", "FreeSlack", "TotalSlack", "PercentComplete", "PercentWorkComplete", "ConstraintType", "CalendarUID", "ConstraintDate", "Deadline", "Notes", "PredecessorLink", "Baseline"];
    for (const t of kids(child(root, "Tasks"), "Task")) {
      const idx = t.children.map((c) => canonical.indexOf(c.name));
      expect(idx.every((i) => i >= 0)).toBe(true);
      expect(idx).toEqual([...idx].sort((a, b) => a - b));
    }
  });

  it("numbers and flags tasks as MS Project does", () => {
    const tasks = kids(child(root, "Tasks"), "Task");
    expect(tasks).toHaveLength(5);
    const f = (i: number, name: string) => child(tasks[i], name)?.text;
    expect([f(0, "Summary"), f(0, "OutlineLevel"), f(0, "WBS")]).toEqual(["1", "1", "1"]);
    expect([f(1, "OutlineLevel"), f(1, "WBS"), f(1, "Duration")]).toEqual(["2", "1.1", "PT24H0M0S"]);
    expect([f(4, "Milestone"), f(4, "Duration")]).toEqual(["1", "PT0H0M0S"]);
    expect(f(3, "ConstraintType")).toBe("4"); // Start No Earlier Than
    expect(f(3, "PercentComplete")).toBe("40");
    expect(f(1, "Start")).toBe("2026-10-05T08:00:00");
  });

  it("writes links with MS Project's type codes and lag in tenths of a minute", () => {
    const tasks = kids(child(root, "Tasks"), "Task");
    const links = kids(tasks[3], "PredecessorLink").map((l) => [child(l, "PredecessorUID")!.text, child(l, "Type")!.text, child(l, "LinkLag")!.text]);
    expect(links).toEqual([["2", "3", "2400"], ["3", "0", "-4800"]]); // SS +4h, FF -1 day
    expect(kids(tasks[2], "PredecessorLink").map((l) => [child(l, "Type")!.text, child(l, "LinkLag")!.text])).toEqual([["1", "4800"]]);
  });

  it("escapes names and notes, writes calendars with exceptions, resources and assignments", () => {
    expect(xml).toContain("Strip &amp; stockpile");
    expect(xml).toContain("Bulk fill &quot;Stage 1&quot;");
    expect(xml).toContain("Allied to confirm &lt;CCTV&gt; scope");
    const cal = child(child(root, "Calendars"), "Calendar")!;
    expect(kids(child(cal, "WeekDays"), "WeekDay")).toHaveLength(7);
    const std = kids(child(cal, "WeekDays"), "WeekDay")[1]!; // Monday
    expect(child(std, "DayType")!.text).toBe("2");
    expect(kids(child(std, "WorkingTimes"), "WorkingTime").map((t) => `${child(t, "FromTime")!.text}-${child(t, "ToTime")!.text}`)).toEqual(["08:00:00-12:00:00", "13:00:00-17:00:00"]);
    expect(kids(child(cal, "Exceptions"), "Exception")).toHaveLength(2);
    expect(child(child(root, "Resources"), "Resource")!.children.find((c) => c.name === "Name")!.text).toBe("Civil gang");
    expect(kids(child(root, "Assignments"), "Assignment")).toHaveLength(1);
  });
});

describe("MSPDI round trip", () => {
  const p = sample();
  const back = importMspdi(exportMspdi(p));

  it("keeps the tasks, outline, links, constraints, notes and baselines", () => {
    expect(back.warnings).toEqual([]);
    expect(back.project.name).toBe(p.name);
    expect(back.project.tasks.map((t) => [t.uid, t.name, t.outline, t.durationMin, t.milestone])).toEqual(p.tasks.map((t) => [t.uid, t.name, t.outline, t.summary ?? t.durationMin, t.milestone]).map((r, i) => [r[0], r[1], r[2], i === 0 ? 0 : p.tasks[i]!.durationMin, r[4]]));
    for (const [i, t] of back.project.tasks.entries()) {
      const o = p.tasks[i]!;
      expect(t.links).toEqual(o.links);
      expect([t.constraint, t.constraintDate, t.deadline, t.notes, t.percent]).toEqual([o.constraint, o.constraintDate, o.deadline, o.notes, o.percent]);
      expect(t.baseline).toEqual(o.baseline);
    }
    expect(back.project.resources).toEqual(p.resources);
    expect(back.project.assignments).toEqual(p.assignments);
  });

  it("keeps calendars, so the schedule comes out the same", () => {
    expect(back.project.calendars[0]!.exceptions.map((e) => [e.name, e.from, e.to, e.working, e.times])).toEqual(p.calendars[0]!.exceptions.map((e) => [e.name, e.from, e.to, e.working, e.times]));
    const a = schedule(p), b = schedule(back.project);
    expect(b.tasks.map((t) => [t.start, t.finish, t.totalSlackMin, t.critical])).toEqual(a.tasks.map((t) => [t.start, t.finish, t.totalSlackMin, t.critical]));
    expect(b.finish).toBe(a.finish);
  });
});

describe("MSPDI import of a file MS Project saved", () => {
  const file = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Project xmlns="http://schemas.microsoft.com/project">
  <Name>Hob.xml</Name><Title>Hob programme</Title><StartDate>2026-10-05T08:00:00</StartDate><MinutesPerDay>480</MinutesPerDay><MinutesPerWeek>2400</MinutesPerWeek><CalendarUID>1</CalendarUID>
  <Calendars>
    <Calendar><UID>1</UID><Name>Standard</Name><IsBaseCalendar>1</IsBaseCalendar><WeekDays>
      <WeekDay><DayType>1</DayType><DayWorking>0</DayWorking></WeekDay>
      <WeekDay><DayType>2</DayType><DayWorking>1</DayWorking><WorkingTimes><WorkingTime><FromTime>07:00:00</FromTime><ToTime>15:30:00</ToTime></WorkingTime></WorkingTimes></WeekDay>
      <WeekDay><DayType>0</DayType><TimePeriod><FromDate>2026-12-25T00:00:00</FromDate><ToDate>2026-12-25T23:59:00</ToDate></TimePeriod><DayWorking>0</DayWorking></WeekDay>
    </WeekDays><Exceptions><Exception><EnteredByOccurrences>1</EnteredByOccurrences><TimePeriod><FromDate>2027-01-01T00:00:00</FromDate><ToDate>2027-01-01T23:59:00</ToDate></TimePeriod><Occurrences>3</Occurrences><Name>New Year</Name><Type>1</Type><DayWorking>0</DayWorking></Exception></Exceptions></Calendar>
    <Calendar><UID>2</UID><Name>Night shift</Name><IsBaseCalendar>0</IsBaseCalendar><BaseCalendarUID>1</BaseCalendarUID><WeekDays><WeekDay><DayType>3</DayType><DayWorking>0</DayWorking></WeekDay></WeekDays></Calendar>
  </Calendars>
  <Tasks>
    <Task><UID>0</UID><ID>0</ID><Name>Hob programme</Name><OutlineLevel>0</OutlineLevel><Summary>1</Summary></Task>
    <Task><UID>1</UID><ID>1</ID><Name>Earthworks</Name><OutlineLevel>1</OutlineLevel><Summary>1</Summary><Duration>PT80H0M0S</Duration></Task>
    <Task><UID>2</UID><ID>2</ID><Name>Strip</Name><OutlineLevel>2</OutlineLevel><Duration>PT16H0M0S</Duration><ConstraintType>0</ConstraintType><Baseline><Number>0</Number><Start>2026-10-05T07:00:00</Start><Finish>2026-10-06T15:30:00</Finish><Duration>PT16H0M0S</Duration></Baseline><Baseline><Number>1</Number><Start>2026-10-05T07:00:00</Start><Finish>2026-10-06T15:30:00</Finish><Duration>PT16H0M0S</Duration></Baseline></Task>
    <Task><UID>3</UID><ID>3</ID><Name>Fill</Name><OutlineLevel>2</OutlineLevel><Duration>PT24H0M0S</Duration><CalendarUID>2</CalendarUID><PredecessorLink><PredecessorUID>2</PredecessorUID><Type>1</Type><LinkLag>0</LinkLag><LagFormat>7</LagFormat></PredecessorLink><PredecessorLink><PredecessorUID>2</PredecessorUID><Type>3</Type><LinkLag>25</LinkLag><LagFormat>19</LagFormat></PredecessorLink></Task>
    <Task><UID>4</UID><ID>4</ID><Name>Hand-dated</Name><OutlineLevel>1</OutlineLevel><Manual>1</Manual><Start>2026-11-02T07:00:00</Start><Duration>PT8H0M0S</Duration></Task>
    <Task><UID>5</UID><ID>5</ID><IsNull>1</IsNull></Task>
  </Tasks>
  <Resources><Resource><UID>0</UID><Name>Unassigned</Name></Resource><Resource><UID>1</UID><Name>Digger</Name><Type>1</Type><MaxUnits>1</MaxUnits></Resource></Resources>
  <Assignments><Assignment><UID>1</UID><TaskUID>2</TaskUID><ResourceUID>1</ResourceUID><Units>1</Units></Assignment><Assignment><UID>2</UID><TaskUID>99</TaskUID><ResourceUID>1</ResourceUID></Assignment></Assignments>
</Project>`;
  const r = importMspdi(file);

  it("skips the project summary task and empty rows, and reads outline, durations and calendars", () => {
    expect(r.project.name).toBe("Hob programme");
    expect(r.project.tasks.map((t) => [t.uid, t.outline])).toEqual([[1, 1], [2, 2], [3, 2], [4, 1]]);
    expect(r.project.tasks[1]!.durationMin).toBe(960);
    expect(r.project.calendars.map((c) => c.name)).toEqual(["Standard", "Night shift"]);
    const std = r.project.calendars[0]!;
    expect(std.week[2]).toEqual({ working: true, times: [{ from: 420, to: 930 }] });
    expect(std.week[1]!.working).toBe(false);
    expect(std.exceptions.map((e) => [e.from, e.working])).toEqual([["2026-12-25", false]]);
    const night = r.project.calendars[1]!;
    expect(night.week[3]!.working).toBe(false); // its own change
    expect(night.week[2]!.times).toEqual([{ from: 420, to: 930 }]); // everything else from its base calendar
    expect(r.project.tasks[2]!.calendarUid).toBe(2);
  });

  it("reads links, baseline 0 and resources, and says what it could not carry", () => {
    expect(r.project.tasks[2]!.links).toEqual([{ uid: 2, type: "FS", lagMin: 0 }, { uid: 2, type: "SS", lagMin: 0 }]);
    expect(r.project.tasks[1]!.baseline).toEqual({ start: "2026-10-05T07:00:00", finish: "2026-10-06T15:30:00", durationMin: 960 });
    expect(r.project.resources.map((x) => x.name)).toEqual(["Digger"]);
    expect(r.project.assignments).toHaveLength(1);
    const w = r.warnings.join(" | ");
    expect(w).toContain("percentage lag");
    expect(w).toContain("recurring exception");
    expect(w).toContain("manually scheduled");
    expect(w).toContain("Baselines 1 to 10");
    expect(r.project.tasks[3]).toMatchObject({ constraint: "SNET", constraintDate: "2026-11-02T07:00:00" });
  });

  it("refuses a file that isn't MS Project XML", () => {
    expect(() => importMspdi("<html></html>")).toThrow(/isn't an MS Project XML file/);
    expect(() => importMspdi("not xml at all")).toThrow();
  });
});
