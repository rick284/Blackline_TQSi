/**
 * QS Takeoff: item amount = sum of build-up cost for its code; rate = amount / qty.
 * Total direct cost = sum of coded items. Section totals group by WBS section.
 */
import { type Dec, ZERO } from "@blackline/engine";
import { d, type QSItem, type RowResult } from "./models.js";

export interface QSLine {
  code: string;
  section: string;
  description: string;
  unit: string;
  quantity: Dec;
  amount: Dec;
  rate: Dec;
}

export interface QSResult {
  lines: QSLine[];
  sectionTotals: Map<string, Dec>;
  totalDirect: Dec;
  /** Build-up cost whose QS code is not in the takeoff. Must be 0. */
  orphanCost: Dec;
}

export function computeQs(items: QSItem[], rows: RowResult[]): QSResult {
  const byCode = new Map<string, Dec>();
  for (const r of rows) byCode.set(r.qsCode, (byCode.get(r.qsCode) ?? ZERO).plus(r.cost));

  const lines: QSLine[] = [];
  const sections = new Map<string, Dec>();
  const known = new Set<string>();
  for (const it of items) {
    known.add(it.code);
    const amount = byCode.get(it.code) ?? ZERO;
    const qty = d(it.quantity);
    lines.push({
      code: it.code, section: it.section, description: it.description, unit: it.unit,
      quantity: qty, amount, rate: qty.isZero() ? ZERO : amount.div(qty),
    });
    sections.set(it.section, (sections.get(it.section) ?? ZERO).plus(amount));
  }
  let orphan = ZERO;
  for (const [code, v] of byCode) if (!known.has(code)) orphan = orphan.plus(v);
  return {
    lines,
    sectionTotals: sections,
    totalDirect: lines.reduce((t, l) => t.plus(l.amount), ZERO),
    orphanCost: orphan,
  };
}
