/**
 * Keeping the tender Programme and the Gantt in step, with no screen in it. Each Gantt task made from a Programme task carries that task's id
 * (`progId`) and the Programme's values for it when the two last agreed (`progSync`). With that, a change can be told from a clash:
 *
 *   only the Programme changed a value  ->  the Gantt follows
 *   only the Gantt changed it           ->  the Programme follows
 *   both changed it, to different things ->  the Programme wins (it is the tender's, and it prices the job) and the clash is reported
 *
 * What carries: the task's name, its length in whole days, and which other linked tasks it follows (finish-to-start, no lag). What stays on its
 * own side: the Gantt's dates, constraints, resources, progress, other link types and lags; the Programme's QS item, basis and notes.
 * A Programme task with no Gantt task gets one (in a summary for its section); a Gantt task whose Programme task is gone is removed.
 */
import { gantt as G } from "@blackline/tender/core";
import { blockEnd, nextUid, type Row } from "./gantt.js";

/** A Programme task as the Gantt sees it. `days` is what the Programme uses (override, else from the estimate); `derived` is what the estimate gives. */
export interface PInfo { id: string; code: string; name: string; days: number; derived: number | null; preds: string[]; section: string }
export interface Patch { name?: string; override_days?: string | null; predecessors?: string[] }

export interface Reconciled {
  rows: Row[];
  /** What to change on Programme tasks, by task id */
  patches: Map<string, Patch>;
  /** Programme tasks that got a new Gantt task */
  created: string[];
  /** Gantt tasks (uids) removed because their Programme task is gone */
  removed: number[];
  /** Clashes the Programme won */
  notes: string[];
  /** How many Gantt tasks changed to follow the Programme, and how many Programme tasks change to follow the Gantt */
  toGantt: number;
  toProgramme: number;
}

export const daysOf = (t: G.GTask, mpd: number) => (t.milestone ? 0 : Math.ceil(t.durationMin / mpd));
const sorted = (xs: string[]) => [...xs].sort();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const isPlainFs = (l: G.Link) => l.type === "FS" && l.lagMin === 0;

/** The Programme's tasks from the estimate's programme result (which has no programme before one is started). */
export function pInfosOf(programme: unknown): PInfo[] | null {
  const p = programme as { setUp?: boolean; tasks?: { id: string; code: string; name: string; duration: number; derived: number | null; predecessors: string[]; section: string }[] } | null;
  if (!p || p.setUp === false || !p.tasks) return null;
  const codes = new Set(p.tasks.map((t) => t.code));
  return p.tasks.map((t) => ({ id: t.id, code: t.code, name: t.name, days: t.duration, derived: t.derived, preds: t.predecessors.filter((c) => codes.has(c)), section: t.section }));
}

function seqBetween(a: number | undefined, b: number | undefined): number {
  if (a === undefined && b === undefined) return 1000;
  if (a === undefined) return b! - 1000;
  if (b === undefined) return a + 1000;
  return (a + b) / 2;
}

/** Work out what has to change on each side. Pure: nothing is written. `structural` also adds and removes tasks. */
export function reconcile(p: PInfo[], rows: Row[], mpd: number, opts: { structural: boolean } = { structural: true }): Reconciled {
  const byId = new Map(p.map((x) => [x.id, x]));
  const codeOf = new Map(p.map((x) => [x.id, x.code]));
  const rowOf = new Map<string, Row>();
  for (const r of rows) if (r.task.progId) rowOf.set(r.task.progId, r);
  const uidOfCode = new Map<string, number>();
  for (const [id, r] of rowOf) { const c = codeOf.get(id); if (c !== undefined) uidOfCode.set(c, r.task.uid); }
  const codeOfUid = new Map([...uidOfCode].map(([c, u]) => [u, c]));

  const patches = new Map<string, Patch>();
  const notes: string[] = [];
  const removed: number[] = [];
  const next = new Map<number, Row>();
  let toGantt = 0, toProgramme = 0;

  for (const r of rows) {
    const t = r.task;
    if (!t.progId) { next.set(t.uid, r); continue; }
    const P = byId.get(t.progId);
    if (!P) { if (opts.structural) removed.push(t.uid); else next.set(t.uid, r); continue; }

    const G_ = { name: t.name, days: daysOf(t, mpd), preds: sorted(t.links.filter((l) => isPlainFs(l) && codeOfUid.has(l.uid)).map((l) => codeOfUid.get(l.uid)!)) };
    const Pl = { name: P.name, days: P.days, preds: sorted(P.preds.filter((c) => uidOfCode.has(c))) };
    const S = t.progSync ? { ...t.progSync, preds: sorted(t.progSync.preds) } : { ...Pl };

    let task = t;
    const patch: Patch = {};
    const nextS = { ...S };
    const decide = <K extends "name" | "days" | "preds">(f: K): "gantt-follows" | "programme-follows" | "none" => {
      const pEq = same(Pl[f], S[f]), gEq = same(G_[f], S[f]);
      if (pEq && gEq) return "none";
      if (!pEq && gEq) { (nextS as Record<string, unknown>)[f] = Pl[f]; return "gantt-follows"; }
      if (pEq && !gEq) { (nextS as Record<string, unknown>)[f] = G_[f]; return "programme-follows"; }
      (nextS as Record<string, unknown>)[f] = Pl[f];
      if (same(Pl[f], G_[f])) return "none";
      notes.push(`"${P.name}": the Programme and the Gantt both changed its ${f === "preds" ? "predecessors" : f === "days" ? "length" : "name"}, so the Programme's was kept.`);
      return "gantt-follows";
    };

    const dn = decide("name");
    if (dn === "gantt-follows") task = { ...task, name: P.name };
    else if (dn === "programme-follows") patch.name = G_.name;

    const dd = decide("days");
    if (dd === "gantt-follows" && G_.days !== P.days) task = { ...task, durationMin: P.days * mpd, milestone: P.days === 0 };
    else if (dd === "programme-follows") patch.override_days = G_.days === P.derived ? null : String(G_.days);

    const dp = decide("preds");
    if (dp === "gantt-follows") {
      const kept = task.links.filter((l) => !(isPlainFs(l) && codeOfUid.has(l.uid)));
      task = { ...task, links: [...kept, ...Pl.preds.map((c) => ({ uid: uidOfCode.get(c)!, type: "FS" as const, lagMin: 0 }))] };
    } else if (dp === "programme-follows") patch.predecessors = [...G_.preds, ...P.preds.filter((c) => !uidOfCode.has(c))];

    if (task !== t) toGantt++;
    if (Object.keys(patch).length) { patches.set(P.id, patch); toProgramme++; }
    if (!same(nextS, t.progSync)) task = { ...task, progSync: nextS };
    next.set(t.uid, task === t ? r : { task, seq: r.seq });
  }

  // Programme tasks with no Gantt task yet: one is made, in a summary for the section
  const created: string[] = [];
  let list = rows.filter((r) => next.has(r.task.uid)).map((r) => next.get(r.task.uid)!);
  if (opts.structural) {
    const missing = p.filter((x) => !rowOf.has(x.id));
    let uid = nextUid(rows);
    const newRows: Row[] = [];
    for (const P of missing) {
      let at = -1;
      const si = list.findIndex((r, i) => r.task.outline === 1 && r.task.name === P.section && !r.task.progId && list[i + 1] && list[i + 1]!.task.outline > 1);
      if (si >= 0) at = blockEnd(list, si);
      else {
        const sectionRow: Row = { task: G.newTask(uid++, P.section, 1), seq: seqBetween(list[list.length - 1]?.seq, undefined) };
        list = [...list, sectionRow];
        at = list.length;
      }
      const t = G.newTask(uid++, P.name, 2);
      t.durationMin = P.days * mpd;
      t.milestone = P.days === 0;
      t.progId = P.id;
      t.progSync = { name: P.name, days: P.days, preds: [] };
      const row: Row = { task: t, seq: seqBetween(list[at - 1]?.seq, list[at]?.seq) };
      list = [...list.slice(0, at), row, ...list.slice(at)];
      newRows.push(row);
      created.push(P.id);
      uidOfCode.set(P.code, t.uid);
    }
    // now that every task has a place, the new ones follow what the Programme says they follow
    for (const row of newRows) {
      const P = byId.get(row.task.progId!)!;
      const preds = sorted(P.preds.filter((c) => uidOfCode.has(c)));
      row.task = { ...row.task, links: preds.map((c) => ({ uid: uidOfCode.get(c)!, type: "FS" as const, lagMin: 0 })), progSync: { name: P.name, days: P.days, preds } };
      toGantt++;
    }
    // a task that followed something now removed loses that link
    const gone = new Set(removed);
    if (gone.size) list = list.map((r) => (r.task.links.some((l) => gone.has(l.uid)) ? { task: { ...r.task, links: r.task.links.filter((l) => !gone.has(l.uid)) }, seq: r.seq } : r));
    toGantt += removed.length;
  }
  return { rows: list, patches, created, removed, notes, toGantt, toProgramme };
}

export interface SyncStatus { toGantt: number; toProgramme: number; created: number; removed: number; clashes: number }
export const inStep = (s: SyncStatus | null) => !s || (s.toGantt === 0 && s.toProgramme === 0 && s.created === 0 && s.removed === 0);

export function statusOf(r: Reconciled): SyncStatus {
  return { toGantt: r.toGantt - r.created.length - r.removed.length, toProgramme: r.toProgramme, created: r.created.length, removed: r.removed.length, clashes: r.notes.length };
}

// ---- adding Gantt tasks to the Programme, and taking them out ------------------------------------------------------------------------------

export interface ProgTask { id: string; code: string; name: string; qs_code: string; override_days: string | null; predecessors: string[]; hammock: boolean; basis: string; note: string }

const CODE_OK = /^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$/;

/**
 * Put Gantt tasks into the Programme as control tasks (no QS item): the task takes its length in days and follows the linked tasks it follows
 * finish to start. Summary tasks and tasks already in the Programme are left alone. Returns the Gantt rows (now linked) and the new Programme tasks.
 */
export function addToProgramme(rows: Row[], uids: number[], progTasks: ProgTask[], mpd: number): { rows: Row[]; tasks: ProgTask[]; skipped: string[] } {
  const skipped: string[] = [];
  const taken = new Set(progTasks.map((t) => t.code));
  const ids = new Set(progTasks.map((t) => t.id));
  const codeOfUid = new Map<number, string>();
  for (const r of rows) if (r.task.progId) { const pt = progTasks.find((t) => t.id === r.task.progId); if (pt) codeOfUid.set(r.task.uid, pt.code); }
  const nextId = () => { for (let n = 1; ; n++) { const id = `P-${String(n).padStart(5, "0")}`; if (!ids.has(id)) { ids.add(id); return id; } } };
  const isSummary = (i: number) => rows[i + 1] !== undefined && rows[i + 1]!.task.outline > rows[i]!.task.outline;
  const chosen: { i: number; r: Row }[] = [];
  rows.forEach((r, i) => { if (uids.includes(r.task.uid)) chosen.push({ i, r }); });
  const tasks: ProgTask[] = [];
  const made = new Map<number, ProgTask>();
  for (const { i, r } of chosen) {
    if (isSummary(i)) { skipped.push(`"${r.task.name}" is a summary task, which the Programme doesn't hold.`); continue; }
    if (r.task.progId) { skipped.push(`"${r.task.name}" is already in the Programme.`); continue; }
    let code = `G${r.task.uid}`;
    for (let k = 2; taken.has(code) || !CODE_OK.test(code); k++) code = `G${r.task.uid}-${k}`;
    taken.add(code);
    const pt: ProgTask = { id: nextId(), code, name: r.task.name.slice(0, 200), qs_code: "", override_days: String(daysOf(r.task, mpd)), predecessors: [], hammock: false, basis: "Added from the Gantt", note: "" };
    made.set(r.task.uid, pt);
    codeOfUid.set(r.task.uid, code);
    tasks.push(pt);
  }
  for (const [uid, pt] of made) {
    const row = rows.find((r) => r.task.uid === uid)!;
    pt.predecessors = row.task.links.filter((l) => isPlainFs(l) && codeOfUid.has(l.uid)).map((l) => codeOfUid.get(l.uid)!);
  }
  const out = rows.map((r) => {
    const pt = made.get(r.task.uid);
    return pt ? { task: { ...r.task, progId: pt.id, progSync: { name: pt.name, days: daysOf(r.task, mpd), preds: sorted(pt.predecessors) } }, seq: r.seq } : r;
  });
  return { rows: out, tasks, skipped };
}

/**
 * Taking linked Gantt tasks out also takes their Programme tasks out, and their codes out of what follows them. Returns the Programme task ids to delete
 * and the predecessor lists to rewrite.
 */
export function removeFromProgramme(rows: Row[], removedUids: number[], progTasks: ProgTask[]): { deletes: string[]; rewrites: Map<string, string[]> } {
  const ids = rows.filter((r) => removedUids.includes(r.task.uid) && r.task.progId).map((r) => r.task.progId!).filter((id) => progTasks.some((t) => t.id === id));
  const codes = new Set(progTasks.filter((t) => ids.includes(t.id)).map((t) => t.code));
  const rewrites = new Map<string, string[]>();
  for (const t of progTasks) if (!ids.includes(t.id) && t.predecessors.some((c) => codes.has(c))) rewrites.set(t.id, t.predecessors.filter((c) => !codes.has(c)));
  return { deletes: ids, rewrites };
}

/** Gantt rows built from the Programme, each linked to its Programme task and in step with it. */
export function fromProgramme(p: PInfo[], mpd: number): Row[] {
  const rows: Row[] = [];
  const sections: string[] = [];
  for (const t of p) if (!sections.includes(t.section)) sections.push(t.section);
  let uid = 1;
  const uidOfCode = new Map<string, number>();
  const plan: { section: string; uid: number; t: PInfo }[] = [];
  const sectionUid = new Map<string, number>();
  for (const s of sections) {
    sectionUid.set(s, uid++);
    for (const t of p.filter((x) => x.section === s)) { uidOfCode.set(t.code, uid); plan.push({ section: s, uid: uid++, t }); }
  }
  for (const s of sections) {
    rows.push({ task: G.newTask(sectionUid.get(s)!, s, 1), seq: (rows.length + 1) * 1000 });
    for (const x of plan.filter((y) => y.section === s)) {
      const task = G.newTask(x.uid, x.t.name, 2);
      task.durationMin = x.t.days * mpd;
      task.milestone = x.t.days === 0;
      const preds = sorted(x.t.preds.filter((c) => uidOfCode.has(c) && uidOfCode.get(c) !== x.uid));
      task.links = preds.map((c) => ({ uid: uidOfCode.get(c)!, type: "FS" as const, lagMin: 0 }));
      task.progId = x.t.id;
      task.progSync = { name: x.t.name, days: x.t.days, preds };
      rows.push({ task, seq: (rows.length + 1) * 1000 });
    }
  }
  return rows;
}
