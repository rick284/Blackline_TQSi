/**
 * Parked changes: a check-in the server refused and kept for a person to compare. The server also says what each record was at the
 * version they checked out (`base`). With that starting point a person sees only what they actually changed, and which of those
 * fields someone else has also changed since: not their whole old copy of the record, which would quietly undo other people's work.
 * Pure, so it is tested without a browser.
 */
import type { RecordData } from "@blackline/tender/core";
import type { ServerRecord } from "./draft.js";

export interface Parked {
  id: string;
  package_id: string;
  package_name: string;
  holder: string;
  holder_name: string;
  base_version: number;
  reason: string;
  created_at: string;
  changes: { upserts: Record<string, RecordData>; deletes: string[] };
  /** Each touched record as it was at `base_version`: its data, null if it was deleted by then, absent if it did not exist. */
  base?: Record<string, RecordData | null>;
}

/**
 * theirs-only  they changed it and nobody else has: safe to take
 * both         they changed it and so did someone else since: a person must choose
 * same-now     it already has their value: nothing to do
 * unknown      there is no starting point to compare against, so this is simply "different"
 */
export type FieldStatus = "theirs-only" | "both" | "same-now" | "unknown";

export interface FieldDiff { field: string; base: unknown; current: unknown; theirs: unknown; status: FieldStatus }

export interface RecordCompare {
  recordId: string;
  label: string;
  /** added: not there now; removed: they deleted it; changed: they changed fields; same: nothing left to decide */
  kind: "added" | "removed" | "changed" | "same";
  current: RecordData | undefined;
  theirs: RecordData | undefined;
  fields: FieldDiff[];
  /** A person should know: the record was deleted since they started, or changed since they deleted it. */
  note?: string;
}

export const REASONS: Record<string, string> = {
  "no-lock": "Their lock had been broken or released before they checked in.",
  "not-holder": "Another person held the package when they checked in.",
  "stale-base": "The package had changed since they checked it out.",
};

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** A short human name for a record: "EW01-001 Site supervisor", not "row:EW01-001". */
export function labelOf(recordId: string, data: RecordData | undefined): string {
  const b = (data?.body ?? {}) as Record<string, any>;
  switch (data?.kind) {
    case "row": return `${b.uid ?? recordId} ${b.task || b.resourceCode || ""}`.trim();
    case "qs": return `${b.code ?? ""} ${b.description ?? ""}`.trim();
    case "library": return `${b.code ?? ""} ${b.description ?? ""}`.trim();
    case "ca": return `${b.ref ?? ""} ${b.name ?? ""}`.trim();
    case "overlay": return String(b.name ?? recordId);
    default: return recordId.replace(/^[a-z]+:/i, "");
  }
}

/** Field-level differences between two record bodies, in the order the fields first appear. */
export function diffBodies(from: unknown, to: unknown): { field: string; from: unknown; to: unknown }[] {
  const a = (from ?? {}) as Record<string, unknown>;
  const b = (to ?? {}) as Record<string, unknown>;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !same(a[k], b[k])).map((field) => ({ field, from: a[field], to: b[field] }));
}

const statusOf = (base: unknown, current: unknown, theirs: unknown, haveBase: boolean): FieldStatus =>
  same(current, theirs) ? "same-now" : !haveBase ? "unknown" : same(current, base) ? "theirs-only" : "both";

export function compareParked(parked: Parked, server: ServerRecord[]): RecordCompare[] {
  const now = new Map(server.filter((r) => r.packageId === parked.package_id).map((r) => [r.id, r.data]));
  const out: RecordCompare[] = [];

  for (const [recordId, theirs] of Object.entries(parked.changes.upserts)) {
    const current = now.get(recordId);
    const base = parked.base?.[recordId];
    if (!current) {
      out.push({ recordId, label: labelOf(recordId, theirs), kind: "added", current, theirs, fields: [], note: base ? "This record has been deleted since they started." : undefined });
      continue;
    }
    // what they changed: against their starting point when there is one, else everything that differs from now
    const touched = base ? diffBodies(base.body, theirs.body) : diffBodies(current.body, theirs.body);
    const fields = touched.map((d): FieldDiff => {
      const cur = (current.body as any)?.[d.field];
      return { field: d.field, base: base ? d.from : undefined, current: cur, theirs: d.to, status: statusOf(d.from, cur, d.to, !!base) };
    });
    const open = fields.filter((f) => f.status !== "same-now");
    out.push({ recordId, label: labelOf(recordId, theirs), kind: open.length ? "changed" : "same", current, theirs, fields });
  }

  for (const recordId of parked.changes.deletes) {
    const current = now.get(recordId);
    const base = parked.base?.[recordId];
    const changedSince = !!current && !!base && !same(current.body, base.body);
    out.push({
      recordId, label: labelOf(recordId, current ?? base ?? undefined), kind: current ? "removed" : "same", current, theirs: undefined, fields: [],
      note: changedSince ? "Someone has changed this record since they started, so deleting it would throw that work away." : undefined,
    });
  }
  return out;
}

/** The current record with only the fields they changed set to their values. Everything else, including other people's work, stays. */
export function mergeTheirs(current: RecordData, c: RecordCompare): RecordData {
  const body = { ...(current.body as Record<string, unknown>) };
  for (const f of c.fields) body[f.field] = f.theirs ?? null;
  return { ...current, body };
}

/** The job's records as they would be if this parked change were applied on top of what is there now. */
export function applyParked(server: ServerRecord[], parked: Parked): ServerRecord[] {
  const byId = new Map(compareParked(parked, server).map((c) => [c.recordId, c]));
  const gone = new Set(parked.changes.deletes);
  const out = server
    .filter((r) => !(r.packageId === parked.package_id && gone.has(r.id)))
    .map((r) => {
      const c = r.packageId === parked.package_id ? byId.get(r.id) : undefined;
      return c && c.kind === "changed" ? { ...r, data: mergeTheirs(r.data, c) } : r;
    });
  const have = new Set(server.filter((r) => r.packageId === parked.package_id).map((r) => r.id));
  for (const [id, data] of Object.entries(parked.changes.upserts)) if (!have.has(id)) out.push({ id, packageId: parked.package_id, data });
  return out;
}

/** How a field value is shown in a comparison: blank is said to be blank, never left as an empty cell. */
export function show(v: unknown): string {
  if (v === null || v === undefined || v === "") return "(blank)";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

/** Camel or snake field names as words: "jobRateOverride" -> "Job rate override". */
export function fieldName(f: string): string {
  const s = f.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export const STATUS_TEXT: Record<FieldStatus, string> = {
  "theirs-only": "Only they changed this",
  both: "You both changed this",
  "same-now": "Already the same",
  unknown: "Different",
};
