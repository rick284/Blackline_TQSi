/**
 * Tender Procurement edits, with no screen in them: a package going out for pricing, an invite to a supplier, and a quote's levelling record.
 * Each returns the record to write, or says what is wrong in words. The rules themselves are in the shared tender package.
 */
import { procurement as P, type RecordData } from "@blackline/tender/core";

export type ProcPackage = P.ProcPackage;
export type ProcInvite = P.ProcInvite;
export type ProcLevel = P.ProcLevel;
export type Made = { ok: true; recordId: string; data: RecordData } | { ok: false; error: string };

const free = (prefix: string, taken: Set<string>) => { for (let n = 1; ; n++) if (!taken.has(`${prefix}${n}`)) return `${prefix}${n}`; };
const fail = (e: unknown): { ok: false; error: string } => ({ ok: false, error: e instanceof P.ProcurementError ? e.message : "That could not be recorded." });

export function newPackage(v: { name: string; overlay?: string; scope?: string }, existing: ProcPackage[], seq: number): Made {
  try {
    const id = free("P", new Set(existing.map((p) => p.id)));
    return { ok: true, recordId: `pp:${id}`, data: { kind: "procPackage", seq, body: P.buildPackage(id, v, existing) } };
  } catch (e) { return fail(e); }
}

export function newInvite(ppId: string, v: { supplier: string; contactId?: string; sent: string; due?: string; note?: string }, existing: ProcInvite[], seq: number): Made {
  try {
    const id = free("I", new Set(existing.map((i) => i.id)));
    return { ok: true, recordId: `pi:${id}`, data: { kind: "procInvite", seq, body: P.buildInvite(id, ppId, v) } };
  } catch (e) { return fail(e); }
}

/** A quote's levelling record is keyed by the quote, so it is made the first time anything is entered for that quote. */
export const levelId = (quoteRef: string) => `pl:${quoteRef}`;

export function writeLevel(current: ProcLevel | undefined, quoteRef: string, change: (l: ProcLevel) => ProcLevel): Made {
  try {
    return { ok: true, recordId: levelId(quoteRef), data: { kind: "procLevel", body: change(current ?? P.blankLevel(quoteRef)) } };
  } catch (e) { return fail(e); }
}

/** Today as a calendar date in the person's own time zone. */
export const todayYmd = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** A message about a quote's validity for the table. */
export function validityText(validUntil: string, today: string): { text: string; expired: boolean } {
  const v = P.validity(validUntil, today);
  if (v.state === "none") return { text: "", expired: false };
  if (v.state === "expired") return { text: `Expired ${-v.days!} day${v.days === -1 ? "" : "s"} ago`, expired: true };
  return { text: v.days === 0 ? "Expires today" : `${v.days} day${v.days === 1 ? "" : "s"} left`, expired: false };
}
