/**
 * Gantt editing, with no screen in it. The tasks are a list of rows, each a task and the `seq` that fixes its place; every operation takes
 * the rows and returns new rows (the old ones are never changed). `diff` then says which records to write: only the rows that changed.
 * The operations are MS Project's: insert, delete, indent, outdent, move up and down, link, unlink, mark complete, baseline.
 */
import { gantt as G } from "@blackline/tender/core";

type GTask = G.GTask;
type Link = G.Link;
export interface Row { task: GTask; seq: number }

const clone = <T,>(x: T): T => structuredClone(x);

export const nextUid = (rows: Row[]) => 1 + Math.max(0, ...rows.map((r) => r.task.uid));
const indexOf = (rows: Row[], uid: number) => rows.findIndex((r) => r.task.uid === uid);
/** The index just after a task's last descendant (the end of its block). */
export function blockEnd(rows: Row[], i: number): number {
  const level = rows[i]!.task.outline;
  let j = i + 1;
  while (j < rows.length && rows[j]!.task.outline > level) j++;
  return j;
}

/** A seq between two neighbours (either may be missing). */
function seqBetween(a: number | undefined, b: number | undefined): number {
  if (a === undefined && b === undefined) return 1000;
  if (a === undefined) return b! - 1000;
  if (b === undefined) return a + 1000;
  return (a + b) / 2;
}

/** If seqs have run out of room between neighbours, renumber everything evenly. */
function tidy(rows: Row[]): Row[] {
  for (let i = 1; i < rows.length; i++) if (!(rows[i]!.seq - rows[i - 1]!.seq > 1e-6)) return rows.map((r, k) => ({ task: r.task, seq: (k + 1) * 1000 }));
  return rows;
}

// ---- insert and delete -------------------------------------------------------------------------------------------------------------
export type InsertKind = "task" | "summary" | "milestone";

/** A new task above the selected one (at its level), or at the end when nothing is selected. A summary also takes the selected tasks into it. */
export function insert(rows: Row[], selected: number[], kind: InsertKind, name?: string): { rows: Row[]; uid: number } {
  const uid = nextUid(rows);
  const sel = rows.map((r, i) => (selected.includes(r.task.uid) ? i : -1)).filter((i) => i >= 0);
  const at = sel.length ? sel[0]! : rows.length;
  const level = sel.length ? rows[at]!.task.outline : 1;
  const t = G.newTask(uid, name ?? (kind === "summary" ? "New summary task" : kind === "milestone" ? "New milestone" : "New task"), level);
  if (kind === "milestone") { t.milestone = true; t.durationMin = 0; }
  const row: Row = { task: t, seq: seqBetween(rows[at - 1]?.seq, rows[at]?.seq) };
  let out = [...rows.slice(0, at), row, ...rows.slice(at)];
  if (kind === "summary" && sel.length) {
    // the selected tasks (and what is inside them) go one level in, under the new summary
    const inside = new Set<number>();
    for (const i of sel) for (let k = i; k < blockEnd(rows, i); k++) inside.add(rows[k]!.task.uid);
    out = out.map((r) => (inside.has(r.task.uid) ? { task: { ...r.task, outline: r.task.outline + 1 }, seq: r.seq } : r));
  }
  return { rows: tidy(out), uid };
}

/** Delete tasks and everything inside a summary among them; links to deleted tasks go too. */
export function remove(rows: Row[], uids: number[]): { rows: Row[]; removed: number[] } {
  const gone = new Set<number>();
  rows.forEach((r, i) => { if (uids.includes(r.task.uid)) for (let k = i; k < blockEnd(rows, i); k++) gone.add(rows[k]!.task.uid); });
  const kept = rows.filter((r) => !gone.has(r.task.uid)).map((r) => (r.task.links.some((l) => gone.has(l.uid)) ? { task: { ...r.task, links: r.task.links.filter((l) => !gone.has(l.uid)) }, seq: r.seq } : r));
  return { rows: kept, removed: [...gone] };
}

// ---- outline -----------------------------------------------------------------------------------------------------------------------
/** The tops of the selected blocks: a selected task inside another selected task's block moves with it. */
function tops(rows: Row[], uids: number[]): number[] {
  const out: number[] = [];
  let skipUntil = -1;
  rows.forEach((r, i) => {
    if (i < skipUntil) return;
    if (uids.includes(r.task.uid)) { out.push(i); skipUntil = blockEnd(rows, i); }
  });
  return out;
}

/** Indent: one level in, only if the task above is at its level or deeper (a task can't sit two levels under its parent). */
export function indent(rows: Row[], uids: number[]): Row[] {
  const out = rows.map((r) => ({ ...r }));
  for (const i of tops(rows, uids)) {
    const prev = out[i - 1];
    if (!prev || prev.task.outline < out[i]!.task.outline) continue;
    for (let k = i; k < blockEnd(rows, i); k++) out[k] = { task: { ...out[k]!.task, outline: out[k]!.task.outline + 1 }, seq: out[k]!.seq };
  }
  return out;
}

export function outdent(rows: Row[], uids: number[]): Row[] {
  const out = rows.map((r) => ({ ...r }));
  for (const i of tops(rows, uids)) {
    if (out[i]!.task.outline <= 1) continue;
    for (let k = i; k < blockEnd(rows, i); k++) out[k] = { task: { ...out[k]!.task, outline: out[k]!.task.outline - 1 }, seq: out[k]!.seq };
  }
  return out;
}

/** Move the selected blocks up (-1) or down (1) past the neighbouring block at the same level. */
export function move(rows: Row[], uids: number[], dir: -1 | 1): Row[] {
  let out = rows;
  const order = dir === -1 ? tops(rows, uids) : tops(rows, uids).reverse();
  for (const start of order) {
    const i = out.findIndex((r) => r.task.uid === rows[start]!.task.uid);
    const level = out[i]!.task.outline;
    const end = blockEnd(out, i);
    if (dir === -1) {
      let j = i - 1;
      while (j >= 0 && out[j]!.task.outline > level) j--;
      if (j < 0 || out[j]!.task.outline < level) continue; // first in its group
      out = place(out, i, end, j);
    } else {
      if (end >= out.length || out[end]!.task.outline < level) continue; // last in its group
      out = place(out, i, end, end + blockEnd(out.slice(end), 0));
    }
  }
  return out;
}

/** Put block [i, end) in front of index `at` (at < i: up; at >= end: down, `at` being the end of what it jumps over). */
function place(rows: Row[], i: number, end: number, at: number): Row[] {
  const block = rows.slice(i, end);
  const without = [...rows.slice(0, i), ...rows.slice(end)];
  const insertAt = at < i ? at : at - block.length;
  const before = without[insertAt - 1]?.seq, after = without[insertAt]?.seq;
  // only the moved rows get new seqs, spread evenly between their new neighbours
  const lo = before ?? (after !== undefined ? after - 1000 * (block.length + 1) : 0), hi = after ?? lo + 1000 * (block.length + 1);
  const moved = block.map((r, k) => ({ task: r.task, seq: lo + ((hi - lo) * (k + 1)) / (block.length + 1) }));
  return tidy([...without.slice(0, insertAt), ...moved, ...without.slice(insertAt)]);
}

// ---- links -------------------------------------------------------------------------------------------------------------------------
/** Whether following `from` after `to` would make a loop: `to` already leads (through links) to `from`. */
function leadsTo(rows: Row[], start: number, goal: number, seen = new Set<number>()): boolean {
  if (start === goal) return true;
  if (seen.has(start)) return false;
  seen.add(start);
  return rows.some((r) => r.task.links.some((l) => l.uid === start) && leadsTo(rows, r.task.uid, goal, seen));
}

export type LinkResult = { rows: Row[]; added: number; skipped: string[] };

/** Link `from` to `to` (to follows from) unless it already is, or would loop. */
export function addLink(rows: Row[], from: number, to: number, type: Link["type"] = "FS", lagMin = 0): LinkResult {
  const skipped: string[] = [];
  const t = rows.find((r) => r.task.uid === to), f = rows.find((r) => r.task.uid === from);
  if (!t || !f) return { rows, added: 0, skipped: ["Both tasks must be in the project."] };
  if (from === to) return { rows, added: 0, skipped: [`"${t.task.name}" can't follow itself.`] };
  if (t.task.links.some((l) => l.uid === from)) return { rows, added: 0, skipped: [`"${t.task.name}" already follows "${f.task.name}".`] };
  if (leadsTo(rows, to, from)) return { rows, added: 0, skipped: [`Linking "${f.task.name}" to "${t.task.name}" would make a loop.`] };
  return { rows: rows.map((r) => (r.task.uid === to ? { task: { ...r.task, links: [...r.task.links, { uid: from, type, lagMin }] }, seq: r.seq } : r)), added: 1, skipped };
}

/** MS Project's Link Tasks: each selected task, in order, is followed by the next. */
export function linkTasks(rows: Row[], uids: number[]): LinkResult {
  const ordered = rows.map((r) => r.task.uid).filter((u) => uids.includes(u));
  let cur = rows, added = 0;
  const skipped: string[] = [];
  for (let i = 1; i < ordered.length; i++) {
    const r = addLink(cur, ordered[i - 1]!, ordered[i]!);
    cur = r.rows; added += r.added; skipped.push(...r.skipped);
  }
  return { rows: cur, added, skipped };
}

/** Unlink Tasks: with one task selected, all the links into it go; with several, the links between them go. */
export function unlinkTasks(rows: Row[], uids: number[]): Row[] {
  const set = new Set(uids);
  return rows.map((r) => {
    if (!set.has(r.task.uid)) return r;
    const keep = uids.length === 1 ? [] : r.task.links.filter((l) => !set.has(l.uid));
    return keep.length === r.task.links.length ? r : { task: { ...r.task, links: keep }, seq: r.seq };
  });
}

// ---- progress, baseline, switching off ------------------------------------------------------------------------------------------------
export function setPercent(rows: Row[], uids: number[], percent: number): Row[] {
  const p = Math.min(100, Math.max(0, Math.round(percent)));
  return rows.map((r) => (uids.includes(r.task.uid) && r.task.percent !== p ? { task: { ...r.task, percent: p }, seq: r.seq } : r));
}
export function setActive(rows: Row[], uids: number[], active: boolean): Row[] {
  return rows.map((r) => (uids.includes(r.task.uid) && r.task.active !== active ? { task: { ...r.task, active }, seq: r.seq } : r));
}
export function setBaseline(rows: Row[], sched: G.ScheduleResult, uids?: number[]): Row[] {
  return rows.map((r) => {
    if (uids && !uids.includes(r.task.uid)) return r;
    const s = sched.byUid.get(r.task.uid);
    return s ? { task: { ...r.task, baseline: { start: s.start, finish: s.finish, durationMin: s.durationMin } }, seq: r.seq } : r;
  });
}
export function clearBaseline(rows: Row[], uids?: number[]): Row[] {
  return rows.map((r) => (!uids || uids.includes(r.task.uid) ? (r.task.baseline ? { task: { ...r.task, baseline: null }, seq: r.seq } : r) : r));
}

// ---- what to write -----------------------------------------------------------------------------------------------------------------
export interface Diff { upserts: { uid: number; task: GTask; seq: number }[]; deletes: number[] }
export function diff(before: Row[], after: Row[]): Diff {
  const old = new Map(before.map((r) => [r.task.uid, r]));
  const upserts = after.filter((r) => { const o = old.get(r.task.uid); return !o || o.seq !== r.seq || JSON.stringify(o.task) !== JSON.stringify(r.task); }).map((r) => ({ uid: r.task.uid, task: r.task, seq: r.seq }));
  const now = new Set(after.map((r) => r.task.uid));
  return { upserts, deletes: before.filter((r) => !now.has(r.task.uid)).map((r) => r.task.uid) };
}

// ---- reading and showing what people type -------------------------------------------------------------------------------------------------
const UNIT_MIN = (u: string, perDay: number, perWeek: number): number | null => {
  const k = u.toLowerCase();
  if (/^(m|min|mins|minute|minutes)$/.test(k)) return 1;
  if (/^(h|hr|hrs|hour|hours)$/.test(k)) return 60;
  if (/^(d|day|days|)$/.test(k)) return perDay;
  if (/^(w|wk|wks|week|weeks)$/.test(k)) return perWeek;
  if (/^(mo|mon|mons|month|months)$/.test(k)) return perDay * 20;
  return null;
};

/** "5", "5d", "5 days", "3h", "2w", "90m" to working minutes; null when it isn't a duration. */
export function parseDuration(text: string, perDay = 480, perWeek = 2400): number | null {
  const m = /^\s*(\d*\.?\d+)\s*([a-zA-Z]*)\s*\??\s*$/.exec(text);
  if (!m) return null;
  const unit = UNIT_MIN(m[2]!, perDay, perWeek);
  if (unit === null) return null;
  return Math.round(Number(m[1]) * unit);
}

/** Working minutes as MS Project shows them: "5 days", "1 day", "4 hrs", "0 days". */
export function formatDuration(min: number, perDay = 480): string {
  if (min === 0) return "0 days";
  const days = min / perDay;
  if (Math.abs(days) >= 1 || min % 60 !== 0) {
    const d = Math.round(days * 100) / 100;
    return `${d} ${d === 1 ? "day" : "days"}`;
  }
  const h = min / 60;
  return `${h} ${h === 1 ? "hr" : "hrs"}`;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const p2 = (n: number) => String(n).padStart(2, "0");

/** A date as typed: 2026-10-05, 5/10/2026, 5/10/26, 5 Oct 2026 (day first, as in NZ). Date only gets `defaultTime`. */
export function parseDate(text: string, defaultTime = "08:00:00"): string | null {
  const s = text.trim().replace(/^[A-Za-z]{3,9},?\s+(?=\d)/, ""); // a leading weekday ("Mon 5/10/26")
  let y: number, mo: number, d: number, rest = "";
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s]+(.*))?$/.exec(s);
  if (m) { y = +m[1]!; mo = +m[2]!; d = +m[3]!; rest = m[4] ?? ""; }
  else if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})(?:\s+(.*))?$/.exec(s))) { d = +m[1]!; mo = +m[2]!; y = +m[3]!; if (y < 100) y += 2000; rest = m[4] ?? ""; }
  else if ((m = /^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{2,4})(?:\s+(.*))?$/.exec(s))) {
    d = +m[1]!; mo = MONTHS.indexOf(m[2]!.slice(0, 3).toLowerCase()) + 1; y = +m[3]!; if (y < 100) y += 2000; rest = m[4] ?? "";
    if (mo < 1) return null;
  } else return null;
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  let time = defaultTime;
  if (rest.trim()) {
    const t = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]m)?$/i.exec(rest.trim());
    if (!t) return null;
    let h = +t[1]!;
    if (t[4]) { h = h % 12 + (t[4].toLowerCase() === "pm" ? 12 : 0); }
    if (h > 23 || +t[2]! > 59) return null;
    time = `${p2(h)}:${t[2]}:00`;
  }
  return `${y}-${p2(mo)}-${p2(d)}T${time}`;
}

/** "Mon 5/10/26", with the time when it isn't the start or end of a standard day. */
export function formatDate(iso: string | null | undefined, withTime = false): string {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  if (!m) return iso;
  const wd = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!)).toLocaleDateString("en-NZ", { weekday: "short", timeZone: "UTC" });
  return `${wd} ${+m[3]!}/${+m[2]!}/${m[1]!.slice(2)}${withTime ? ` ${m[4]}:${m[5]}` : ""}`;
}

// ---- predecessors, as MS Project writes them: "3", "3FS+2d", "5SS-1d" (by row number) ---------------------------------------------------------------
export function formatLinks(links: Link[], idOf: (uid: number) => number | undefined, perDay = 480): string {
  return links.map((l) => {
    const id = idOf(l.uid);
    if (id === undefined) return "";
    const lag = l.lagMin === 0 ? "" : `${l.lagMin > 0 ? "+" : "-"}${formatDuration(Math.abs(l.lagMin), perDay).replace(/ days?$/, "d").replace(/ hrs?$/, "h")}`;
    return `${id}${l.type === "FS" && l.lagMin === 0 ? "" : l.type}${lag}`;
  }).filter(Boolean).join(", ");
}

/** Reads "3, 5SS+2d, 7FF-1w" into links by task id; says what is wrong in words. */
export function parseLinks(text: string, uidOf: (id: number) => number | undefined, selfUid: number, perDay = 480, perWeek = 2400): { ok: true; links: Link[] } | { ok: false; error: string } {
  const links: Link[] = [];
  for (const part of text.split(/[,;]/).map((x) => x.trim()).filter(Boolean)) {
    const m = /^(\d+)\s*(FS|FF|SS|SF)?\s*(?:([+-])\s*(.+))?$/i.exec(part);
    if (!m) return { ok: false, error: `"${part}" isn't a predecessor. Write the task number, then the link type and lag if you need them: 3, 5SS+2d, 7FF-1w.` };
    const uid = uidOf(Number(m[1]));
    if (uid === undefined) return { ok: false, error: `There is no task ${m[1]}.` };
    if (uid === selfUid) return { ok: false, error: "A task can't follow itself." };
    let lag = 0;
    if (m[3]) {
      const d = parseDuration(m[4]!, perDay, perWeek);
      if (d === null) return { ok: false, error: `"${m[4]}" isn't a lag. Try 2d, 4h or 1w.` };
      lag = m[3] === "-" ? -d : d;
    }
    if (links.some((l) => l.uid === uid)) return { ok: false, error: `Task ${m[1]} is listed twice.` };
    links.push({ uid, type: (m[2]?.toUpperCase() as Link["type"]) ?? "FS", lagMin: lag });
  }
  return { ok: true, links };
}
