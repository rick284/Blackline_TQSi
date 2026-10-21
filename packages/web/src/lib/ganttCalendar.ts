/**
 * Calendar editing for the Gantt ("Change Working Time"), with no screen in it. A calendar says which days work and when; exceptions
 * (holidays, shutdowns, a working Saturday) override a day or a run of days. Every function returns a new calendar or says what is wrong.
 */
import { gantt as G } from "@blackline/tender/core";
import { parseDate } from "./gantt.js";

export type Edited<T> = { ok: true; body: T } | { ok: false; error: string };

export const DAY_NAMES = ["", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** Display order: the working week first, as MS Project's calendar shows it. */
export const WEEK_ORDER = [2, 3, 4, 5, 6, 7, 1];

const p2 = (n: number) => String(n).padStart(2, "0");
const clock = (min: number) => `${p2(Math.floor(min / 60))}:${p2(min % 60)}`;

/** "08:00-12:00, 13:00-17:00" (also 8-12, 8am-12pm) to working times; says what is wrong. */
export function parseTimes(text: string): Edited<G.WorkTime[]> {
  const out: G.WorkTime[] = [];
  const one = (s: string): number | null => {
    const m = /^(\d{1,2})(?::(\d{2}))?\s*([ap]m)?$/i.exec(s.trim());
    if (!m) return null;
    let h = +m[1]!;
    const min = +(m[2] ?? 0);
    if (m[3]) { if (h < 1 || h > 12) return null; h = (h % 12) + (m[3].toLowerCase() === "pm" ? 12 : 0); }
    if (min > 59 || h > 24 || (h === 24 && min > 0)) return null;
    return h * 60 + min;
  };
  for (const part of text.split(/[,;]/).map((x) => x.trim()).filter(Boolean)) {
    const [a, b, ...rest] = part.split(/\s*(?:-|to|–)\s*/i);
    const from = a === undefined ? null : one(a), to = b === undefined ? null : one(b);
    if (from === null || to === null || rest.length) return { ok: false, error: `"${part}" isn't a working time. Write it like 08:00-12:00.` };
    if (to <= from) return { ok: false, error: `"${part}" finishes before it starts.` };
    out.push({ from, to });
  }
  out.sort((x, y) => x.from - y.from);
  for (let i = 1; i < out.length; i++) if (out[i]!.from < out[i - 1]!.to) return { ok: false, error: `${clock(out[i - 1]!.from)}-${clock(out[i - 1]!.to)} and ${clock(out[i]!.from)}-${clock(out[i]!.to)} overlap.` };
  return { ok: true, body: out };
}

export const formatTimes = (times: G.WorkTime[]) => times.map((t) => `${clock(t.from)}-${clock(t.to)}`).join(", ");
export const minutesOf = (times: G.WorkTime[]) => times.reduce((a, t) => a + (t.to - t.from), 0);

/** A weekday set to non-working, or to these working times. */
export function setWeekDay(cal: G.GCalendar, day: number, times: G.WorkTime[]): G.GCalendar {
  return { ...cal, week: { ...cal.week, [day]: { working: times.length > 0, times } } };
}

export function addException(cal: G.GCalendar, e: { name: string; from: string; to: string; working: boolean; times: G.WorkTime[] }): Edited<G.GCalendar> {
  const from = parseDate(e.from), to = parseDate(e.to || e.from);
  if (!from) return { ok: false, error: `"${e.from}" isn't a date. Try 25/12/26.` };
  if (!to) return { ok: false, error: `"${e.to}" isn't a date. Try 25/12/26.` };
  const f = from.slice(0, 10), t = to.slice(0, 10);
  if (t < f) return { ok: false, error: "The exception finishes before it starts." };
  if (e.name.trim().length > 120) return { ok: false, error: "The name is too long (limit 120 characters)." };
  if (e.working && e.times.length === 0) return { ok: false, error: "A working exception needs working times, for example 08:00-12:00." };
  return { ok: true, body: { ...cal, exceptions: [...cal.exceptions, { name: e.name.trim(), from: f, to: t, working: e.working, times: e.working ? e.times : [] }] } };
}

export const removeException = (cal: G.GCalendar, index: number): G.GCalendar => ({ ...cal, exceptions: cal.exceptions.filter((_, i) => i !== index) });

export function renameCalendar(cal: G.GCalendar, name: string, all: G.GCalendar[]): Edited<G.GCalendar> {
  const n = name.trim();
  if (!n) return { ok: false, error: "A calendar needs a name." };
  if (n.length > 80) return { ok: false, error: "The name is too long (limit 80 characters)." };
  if (all.some((c) => c.uid !== cal.uid && c.name.toLowerCase() === n.toLowerCase())) return { ok: false, error: `${n} is already a calendar.` };
  return { ok: true, body: { ...cal, name: n } };
}

/** A new calendar that starts as a copy of another. */
export function newCalendar(name: string, base: G.GCalendar, all: G.GCalendar[]): Edited<G.GCalendar> {
  const uid = 1 + Math.max(0, ...all.map((c) => c.uid));
  const r = renameCalendar({ ...structuredClone(base), uid }, name, all);
  return r;
}

/** Whether a calendar can be deleted: not the project's, not the last, not one a task uses. */
export function canDelete(project: G.GProject, uid: number): { ok: true } | { ok: false; why: string } {
  if (project.calendars.length <= 1) return { ok: false, why: "The project needs at least one calendar." };
  if (project.calendarUid === uid) return { ok: false, why: "This is the project calendar. Make another calendar the project calendar first." };
  const used = project.tasks.filter((t) => t.calendarUid === uid);
  if (used.length) return { ok: false, why: `${used.length} task${used.length === 1 ? " uses" : "s use"} this calendar ("${used[0]!.name}"${used.length > 1 ? " and others" : ""}). Give them another calendar first.` };
  return { ok: true };
}

/** Hours worked in a typical working day and in a week, for the Project's "hours per day / per week". */
export function typicalHours(cal: G.GCalendar): { perDay: number; perWeek: number } {
  const days = WEEK_ORDER.map((d) => (cal.week[d]?.working ? minutesOf(cal.week[d]!.times) : 0));
  const working = days.filter((m) => m > 0);
  return { perDay: working.length ? Math.round(working.sort((a, b) => a - b)[Math.floor(working.length / 2)]!) : 0, perWeek: days.reduce((a, m) => a + m, 0) };
}
