/**
 * Working-time arithmetic. Everything is whole minutes counted from 1970-01-01 00:00 on a calendar with no time zone, so a date-time text
 * "2026-10-05T08:00:00" is one number. A calendar has working times per weekday and dated exceptions (holidays, shutdowns, working Saturdays).
 */
import type { GCalendar, WorkTime } from "./types.js";

const DAY = 1440;

/** "2026-10-05T08:00:00" (or a bare date) to minutes. */
export function toMin(s: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (!m) throw new Error(`Not a date: ${s}`);
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +(m[4] ?? 0), +(m[5] ?? 0)) / 60000;
}

const p2 = (n: number) => String(n).padStart(2, "0");
/** Minutes to "2026-10-05T08:00:00". */
export function fromMin(t: number): string {
  const d = new Date(t * 60000);
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}T${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:00`;
}
export const dateOf = (t: number) => fromMin(t).slice(0, 10);
export const dayStart = (t: number) => Math.floor(t / DAY) * DAY;
/** 1 = Sunday ... 7 = Saturday */
export const weekdayOf = (t: number) => new Date(t * 60000).getUTCDay() + 1;

const LIMIT_DAYS = 366 * 40;

export class WorkCalendar {
  private cache = new Map<number, WorkTime[]>();
  readonly hasWork: boolean;
  constructor(readonly cal: GCalendar) {
    this.hasWork = Object.values(cal.week).some((w) => w.working && w.times.some((t) => t.to > t.from)) || cal.exceptions.some((e) => e.working && e.times.some((t) => t.to > t.from));
  }

  /** The working windows of the day that starts at `day` (a multiple of 1440), as absolute minutes, in order. */
  windows(day: number): WorkTime[] {
    const hit = this.cache.get(day);
    if (hit) return hit;
    const date = dateOf(day);
    const ex = this.cal.exceptions.filter((e) => e.from <= date && date <= e.to).pop();
    const wk = this.cal.week[weekdayOf(day)] ?? { working: false, times: [] };
    let times: WorkTime[];
    if (ex) times = ex.working ? (ex.times.length ? ex.times : wk.times) : [];
    else times = wk.working ? wk.times : [];
    const out = times.filter((t) => t.to > t.from).sort((a, b) => a.from - b.from).map((t) => ({ from: day + t.from, to: day + t.to }));
    this.cache.set(day, out);
    return out;
  }

  /** The earliest working moment at or after `t`: `t` itself inside working time, otherwise the start of the next window. */
  nextStart(t: number): number {
    if (!this.hasWork) return t;
    let day = dayStart(t);
    for (let i = 0; i < LIMIT_DAYS; i++, day += DAY) {
      for (const w of this.windows(day)) {
        if (t < w.to) return Math.max(t, w.from);
      }
    }
    return t;
  }

  /** The latest working moment at or before `t`: `t` itself if it ends or sits inside a window, otherwise the end of the previous window. */
  prevEnd(t: number): number {
    if (!this.hasWork) return t;
    let day = dayStart(t);
    for (let i = 0; i < LIMIT_DAYS; i++, day -= DAY) {
      const ws = this.windows(day);
      for (let k = ws.length - 1; k >= 0; k--) {
        const w = ws[k]!;
        if (t > w.from) return Math.min(t, w.to);
      }
    }
    return t;
  }

  /** Move forward `minutes` of working time from `from`; the result is the moment the last minute ends. Zero returns `from`. */
  add(from: number, minutes: number): number {
    if (minutes === 0) return from;
    if (minutes < 0) return this.sub(from, -minutes);
    if (!this.hasWork) return from + minutes;
    let t = this.nextStart(from);
    let left = minutes;
    let day = dayStart(t);
    for (let i = 0; i < LIMIT_DAYS; i++, day += DAY) {
      for (const w of this.windows(day)) {
        if (t >= w.to) continue;
        const s = Math.max(t, w.from);
        const room = w.to - s;
        if (left <= room) return s + left;
        left -= room;
        t = w.to;
      }
    }
    return t;
  }

  /** Move back `minutes` of working time from `from` (a finish); the result is the moment the first minute starts. Zero returns `from`. */
  sub(from: number, minutes: number): number {
    if (minutes === 0) return from;
    if (minutes < 0) return this.add(from, -minutes);
    if (!this.hasWork) return from - minutes;
    let t = this.prevEnd(from);
    let left = minutes;
    let day = dayStart(t);
    for (let i = 0; i < LIMIT_DAYS; i++, day -= DAY) {
      const ws = this.windows(day);
      for (let k = ws.length - 1; k >= 0; k--) {
        const w = ws[k]!;
        if (t <= w.from) continue;
        const e = Math.min(t, w.to);
        const room = e - w.from;
        if (left <= room) return e - left;
        left -= room;
        t = w.from;
      }
    }
    return t;
  }

  /** Working minutes between two moments (negative when `b` is before `a`). */
  between(a: number, b: number): number {
    if (a === b) return 0;
    if (b < a) return -this.between(b, a);
    if (!this.hasWork) return b - a;
    let total = 0;
    for (let day = dayStart(a); day < b; day += DAY) {
      for (const w of this.windows(day)) {
        const s = Math.max(a, w.from), e = Math.min(b, w.to);
        if (e > s) total += e - s;
      }
    }
    return total;
  }
}
