/**
 * Drafts: the edits an estimator has made to packages they hold. Pure functions, no browser APIs, so they are testable and the same
 * rules apply on any machine. A draft is a record body keyed by package and record id; `null` means "deleted". Nothing here talks to the
 * server: check-in sends `changeSetOf(...)`, and the server decides.
 */
import type { RecordData } from "@blackline/tender/core";

export interface ServerRecord {
  id: string;
  packageId: string;
  data: RecordData;
}

/** packageId -> recordId -> the draft record, or null when the record is deleted in the draft. */
export type Drafts = Record<string, Record<string, RecordData | null>>;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The records as the estimator sees them: the server's checked-in records with their own drafts laid over the packages they hold. */
export function effectiveRecords(server: ServerRecord[], drafts: Drafts): ServerRecord[] {
  const out: ServerRecord[] = [];
  const seen = new Set<string>();
  for (const r of server) {
    seen.add(`${r.packageId}/${r.id}`);
    const d = drafts[r.packageId]?.[r.id];
    if (d === null) continue;
    out.push(d ? { ...r, data: d } : r);
  }
  for (const [packageId, recs] of Object.entries(drafts))
    for (const [id, d] of Object.entries(recs)) if (d && !seen.has(`${packageId}/${id}`)) out.push({ id, packageId, data: d });
  return out;
}

/** What check-in sends: records that differ from the server's, and records deleted. */
export function changeSetOf(packageId: string, drafts: Drafts) {
  const upserts: Record<string, RecordData> = {};
  const deletes: string[] = [];
  for (const [id, d] of Object.entries(drafts[packageId] ?? {})) {
    if (d === null) deletes.push(id);
    else upserts[id] = d;
  }
  return { upserts, deletes };
}

export function countChanges(drafts: Drafts, packageId?: string): number {
  const pkgs = packageId ? [packageId] : Object.keys(drafts);
  return pkgs.reduce((t, p) => t + Object.keys(drafts[p] ?? {}).length, 0);
}

/**
 * Edit one record of a held package. `edit` receives the record's current body (draft if there is one, else the server's) and returns
 * the new body. A record edited back to the server's value stops being a change.
 */
export function editRecord(drafts: Drafts, server: ServerRecord[], packageId: string, recordId: string, edit: (body: any) => any): Drafts {
  const base = server.find((r) => r.packageId === packageId && r.id === recordId);
  const current = drafts[packageId]?.[recordId] ?? base?.data;
  if (!current) throw new Error(`No record ${recordId} in this package.`);
  const next: RecordData = { ...current, body: edit(structuredClone(current.body)) };
  return withDraft(drafts, packageId, recordId, base && same(base.data, next) ? undefined : next);
}

/** Set a record to exactly this (or delete it with null). Setting it back to what the server has is no change at all. */
export function setRecord(drafts: Drafts, server: ServerRecord[], packageId: string, recordId: string, data: RecordData | null): Drafts {
  if (data === null) return deleteRecord(drafts, server, packageId, recordId);
  const base = server.find((r) => r.packageId === packageId && r.id === recordId);
  return withDraft(drafts, packageId, recordId, base && same(base.data, data) ? undefined : data);
}

/** A record made in the draft (a new build-up row, say). */
export function addRecord(drafts: Drafts, packageId: string, recordId: string, data: RecordData): Drafts {
  return withDraft(drafts, packageId, recordId, data);
}

/** Delete a record in the draft. A record that only ever existed in the draft simply disappears. */
export function deleteRecord(drafts: Drafts, server: ServerRecord[], packageId: string, recordId: string): Drafts {
  const onServer = server.some((r) => r.packageId === packageId && r.id === recordId);
  return withDraft(drafts, packageId, recordId, onServer ? null : undefined);
}

export function discardPackage(drafts: Drafts, packageId: string): Drafts {
  const { [packageId]: _gone, ...rest } = drafts;
  return rest;
}

function withDraft(drafts: Drafts, packageId: string, recordId: string, value: RecordData | null | undefined): Drafts {
  const pkg = { ...(drafts[packageId] ?? {}) };
  if (value === undefined) delete pkg[recordId];
  else pkg[recordId] = value;
  const { [packageId]: _old, ...rest } = drafts;
  return Object.keys(pkg).length ? { ...rest, [packageId]: pkg } : rest;
}

/** Parse what someone typed into a number cell: blank is cleared (null), anything else must be a plain decimal. */
export function parseNumberCell(text: unknown): { ok: true; value: string | null } | { ok: false } {
  const s = String(text ?? "").trim().replace(/,/g, "");
  if (s === "") return { ok: true, value: null };
  return /^-?\d*\.?\d+$|^-?\d+\.$/.test(s) ? { ok: true, value: s.endsWith(".") ? s.slice(0, -1) : s } : { ok: false };
}
