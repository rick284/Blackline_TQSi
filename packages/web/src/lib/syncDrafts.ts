/**
 * Carrying changes between the Programme and the Gantt as part of the edit that caused them. `syncAcross` takes the drafts as an edit left
 * them, works out what each side now owes the other (`reconcile`), and returns the drafts with that written in, so one undo takes back the
 * edit and its knock-on together. It only acts when the Gantt is linked to the Programme and the person holds both packages.
 */
import { effectiveRecords, setRecord, type Drafts, type ServerRecord } from "./draft.js";
import { buildModel } from "./model.js";
import * as X from "./gantt.js";
import { reconcile, type Patch, type Reconciled } from "./programmeSync.js";

export interface PackageIds { gantt: string; programme: string }
export interface Synced { drafts: Drafts; notes: string[]; carried: { toGantt: number; toProgramme: number; created: number; removed: number } }

const none = (drafts: Drafts): Synced => ({ drafts, notes: [], carried: { toGantt: 0, toProgramme: 0, created: 0, removed: 0 } });

export function syncAcross(records: ServerRecord[], drafts: Drafts, ids: PackageIds): Synced {
  const eff = effectiveRecords(records, drafts);
  const m = buildModel(eff);
  if (!m.gantt?.progLink || !m.programmeInfos) return none(drafts);
  const r: Reconciled = reconcile(m.programmeInfos, m.ganttRows, m.gantt.minutesPerDay);
  const d = X.diff(m.ganttRows, r.rows);
  if (!d.upserts.length && !d.deletes.length && r.patches.size === 0) return none(drafts);

  let out = drafts;
  for (const u of d.upserts) out = setRecord(out, records, ids.gantt, `gtask:${u.uid}`, { kind: "ganttTask", seq: u.seq, body: u.task });
  for (const uid of d.deletes) {
    out = setRecord(out, records, ids.gantt, `gtask:${uid}`, null);
    for (const a of m.gantt.assignments.filter((x) => x.taskUid === uid)) out = setRecord(out, records, ids.gantt, `gasg:${a.uid}`, null);
  }
  const bodyOf = new Map(eff.filter((x) => x.data.kind === "task").map((x) => [x.id, x.data]));
  for (const [pid, patch] of r.patches as Map<string, Patch>) {
    const cur = bodyOf.get(`task:${pid}`);
    if (!cur) continue;
    const body = { ...(cur.body as Record<string, unknown>) };
    if (patch.name !== undefined) body.name = patch.name;
    if (patch.override_days !== undefined) body.override_days = patch.override_days;
    if (patch.predecessors) body.predecessors = [...new Set(patch.predecessors)];
    out = setRecord(out, records, ids.programme, `task:${pid}`, { ...cur, body });
  }
  const notes = [...r.notes];
  const bits: string[] = [];
  if (r.toProgramme) bits.push(`${r.toProgramme} change${r.toProgramme === 1 ? "" : "s"} from the Gantt to the Programme`);
  const toGantt = r.toGantt - r.created.length - r.removed.length;
  if (toGantt > 0) bits.push(`${toGantt} change${toGantt === 1 ? "" : "s"} from the Programme to the Gantt`);
  if (r.created.length) bits.push(`${r.created.length} new task${r.created.length === 1 ? "" : "s"} added to the Gantt`);
  if (r.removed.length) bits.push(`${r.removed.length} task${r.removed.length === 1 ? "" : "s"} taken out of the Gantt`);
  if (bits.length) notes.unshift(`Carried across: ${bits.join(", ")}.`);
  return { drafts: out, notes, carried: { toGantt, toProgramme: r.toProgramme, created: r.created.length, removed: r.removed.length } };
}
