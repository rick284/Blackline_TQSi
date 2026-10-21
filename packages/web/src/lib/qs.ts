/**
 * Adding and deleting QS takeoff items, with no screen in them. A new item joins the section of the item you are on (so it lives in the
 * same package, which you already hold); deleting an item takes its build-up rows with it, so no cost is left behind with nothing to hang on.
 */
import type { RecordData } from "@blackline/tender/core";
import type { Model } from "./model.js";

export const QS_CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,23}$/;

export type NewItem = { ok: true; recordId: string; data: RecordData } | { ok: false; error: string };

/** A new, empty item: quantity zero, so it prices nothing until rows and a quantity are given. */
export function newQsItem(code: string, section: string, existingCodes: string[], seq: number): NewItem {
  const c = code.trim();
  if (!QS_CODE.test(c)) return { ok: false, error: "A code is letters, numbers, dots and dashes, up to 24 characters, for example EW10." };
  if (existingCodes.some((x) => x.toLowerCase() === c.toLowerCase())) return { ok: false, error: `${c} is already in the takeoff.` };
  return { ok: true, recordId: `qs:${c}`, data: { kind: "qs", seq, body: { code: c, section, description: "", unit: "", quantity: "0" } } };
}

/** What deleting an item removes: the item and every build-up row under it. */
export function qsDeletion(model: Model, code: string): { records: { packageId: string; recordId: string }[]; rows: number } | null {
  const item = model.qsRows.find((r) => r.kind === "item" && r.code === code);
  if (!item) return null;
  const rows = model.buildups.get(code) ?? [];
  return { records: [{ packageId: item.packageId, recordId: item.recordId }, ...rows.map((r) => ({ packageId: r.packageId, recordId: r.recordId }))], rows: rows.length };
}
