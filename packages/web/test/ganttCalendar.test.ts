import { describe, expect, it } from "vitest";
import { gantt as G } from "@blackline/tender/core";
import * as C from "../src/lib/ganttCalendar.js";

describe("working times", () => {
  it("reads times in several forms", () => {
    expect(C.parseTimes("08:00-12:00, 13:00-17:00")).toEqual({ ok: true, body: [{ from: 480, to: 720 }, { from: 780, to: 1020 }] });
    expect(C.parseTimes("8-12; 1pm-5pm")).toEqual({ ok: true, body: [{ from: 480, to: 720 }, { from: 780, to: 1020 }] });
    expect(C.parseTimes("07:30 to 15:30")).toEqual({ ok: true, body: [{ from: 450, to: 930 }] });
    expect(C.parseTimes("17:00-24:00")).toEqual({ ok: true, body: [{ from: 1020, to: 1440 }] });
    expect(C.parseTimes("")).toEqual({ ok: true, body: [] });
  });
  it("says what is wrong", () => {
    expect(C.parseTimes("12:00-08:00")).toMatchObject({ ok: false, error: expect.stringContaining("before it starts") });
    expect(C.parseTimes("08:00-13:00, 12:00-17:00")).toMatchObject({ ok: false, error: expect.stringContaining("overlap") });
    expect(C.parseTimes("breakfast")).toMatchObject({ ok: false });
    expect(C.parseTimes("25:00-26:00")).toMatchObject({ ok: false });
    expect(C.parseTimes("8")).toMatchObject({ ok: false });
  });
  it("shows them the way it reads them, and counts the minutes", () => {
    expect(C.formatTimes([{ from: 480, to: 720 }, { from: 780, to: 1020 }])).toBe("08:00-12:00, 13:00-17:00");
    expect(C.minutesOf([{ from: 480, to: 720 }, { from: 780, to: 1020 }])).toBe(480);
  });
});

describe("a calendar's week and exceptions", () => {
  const std = G.standardCalendar();
  it("changes a weekday without touching the original, and a day with no times is non-working", () => {
    const sat = C.setWeekDay(std, 7, [{ from: 480, to: 720 }]);
    expect(sat.week[7]).toEqual({ working: true, times: [{ from: 480, to: 720 }] });
    expect(std.week[7]!.working).toBe(false);
    expect(C.setWeekDay(sat, 7, []).week[7]).toEqual({ working: false, times: [] });
    // and it schedules differently: 4 hours on a Saturday now count
    const wc = new G.WorkCalendar(sat);
    expect(wc.between(G.toMin("2026-10-10T00:00:00"), G.toMin("2026-10-11T00:00:00"))).toBe(240);
  });
  it("adds and removes exceptions, and a holiday takes the day out of the schedule", () => {
    const r = C.addException(std, { name: "Labour Day", from: "26/10/26", to: "", working: false, times: [] });
    expect(r).toMatchObject({ ok: true, body: { exceptions: [{ name: "Labour Day", from: "2026-10-26", to: "2026-10-26", working: false }] } });
    if (!r.ok) return;
    const wc = new G.WorkCalendar(r.body);
    expect(G.fromMin(wc.add(G.toMin("2026-10-23T16:00:00"), 120))).toBe("2026-10-27T09:00:00");
    expect(C.removeException(r.body, 0).exceptions).toEqual([]);
    const run = C.addException(std, { name: "Shutdown", from: "2026-12-24", to: "2027-01-04", working: false, times: [] });
    expect(run).toMatchObject({ ok: true, body: { exceptions: [{ from: "2026-12-24", to: "2027-01-04" }] } });
  });
  it("refuses bad exceptions in words", () => {
    expect(C.addException(std, { name: "x", from: "soon", to: "", working: false, times: [] })).toMatchObject({ ok: false });
    expect(C.addException(std, { name: "x", from: "2026-10-26", to: "2026-10-20", working: false, times: [] })).toMatchObject({ ok: false, error: expect.stringContaining("before it starts") });
    expect(C.addException(std, { name: "x", from: "2026-10-17", to: "", working: true, times: [] })).toMatchObject({ ok: false, error: expect.stringContaining("working times") });
    expect(C.addException(std, { name: "Saturday", from: "2026-10-17", to: "", working: true, times: [{ from: 480, to: 720 }] })).toMatchObject({ ok: true });
  });
});

describe("calendars of a project", () => {
  const p = G.newProject("2026-10-05T08:00:00");
  it("makes a copy under a new name, with the next uid", () => {
    const r = C.newCalendar("Night shift", p.calendars[0]!, p.calendars);
    expect(r).toMatchObject({ ok: true, body: { uid: 2, name: "Night shift" } });
    expect(C.newCalendar("standard", p.calendars[0]!, p.calendars)).toMatchObject({ ok: false, error: expect.stringContaining("already") });
    expect(C.renameCalendar(p.calendars[0]!, " ", p.calendars)).toMatchObject({ ok: false });
  });
  it("won't delete the project calendar, the last one, or one a task uses", () => {
    expect(C.canDelete(p, 1)).toMatchObject({ ok: false, why: expect.stringContaining("at least one") });
    const two = { ...p, calendars: [...p.calendars, { ...G.standardCalendar(2, "Six day") }] };
    expect(C.canDelete(two, 1)).toMatchObject({ ok: false, why: expect.stringContaining("project calendar") });
    const t = G.newTask(1, "Night pour"); t.calendarUid = 2;
    expect(C.canDelete({ ...two, tasks: [t] }, 2)).toMatchObject({ ok: false, why: expect.stringContaining("Night pour") });
    expect(C.canDelete(two, 2)).toEqual({ ok: true });
  });
  it("works out hours a day and a week", () => {
    expect(C.typicalHours(G.standardCalendar())).toEqual({ perDay: 480, perWeek: 2400 });
    expect(C.typicalHours(C.setWeekDay(G.standardCalendar(), 7, [{ from: 480, to: 720 }]))).toEqual({ perDay: 480, perWeek: 2640 });
  });
});
