/**
 * Resource Build-Up: per-row cost. Mirrors the workbook formulas exactly.
 *
 *   calc duration hrs   = QS qty / productivity rate          (blank if no productivity)
 *   applied duration    = override if > 0 else calc duration
 *   applied rate        = job override if > 0 else library rate
 *   Time x Count        = applied hrs x count x (utilisation, blank = 1) x applied rate
 *   QS Qty x Factor     = QS qty x count x (1 + waste) x applied rate
 *   Direct Qty          = manual qty x (1 + waste) x applied rate
 *   Lump Sum / Quote    = manual qty x applied rate
 * Blank numeric inputs behave as 0 (spreadsheet semantics) except utilisation (blank = 1).
 */
import { type Dec, ZERO } from "@blackline/engine";
import {
  type BuildUpRow, d, type LibraryRate, MODE_DIRECT, MODE_LUMP, MODE_QTY, MODE_TIME, MODES, type QSItem, type RowResult,
} from "./models.js";

export class BuildUpError extends Error {}

const ONE = d(1);

export function rowCost(row: BuildUpRow, qsQty: Dec, appliedHrs: Dec, appliedRate: Dec): Dec {
  const waste = d(row.waste);
  switch (row.mode) {
    case MODE_TIME: {
      const util = row.utilisation === null || row.utilisation === undefined ? ONE : d(row.utilisation);
      return appliedHrs.times(d(row.count)).times(util).times(appliedRate);
    }
    case MODE_QTY:
      return qsQty.times(d(row.count)).times(ONE.plus(waste)).times(appliedRate);
    case MODE_DIRECT:
      return d(row.manualQty).times(ONE.plus(waste)).times(appliedRate);
    case MODE_LUMP:
      return d(row.manualQty).times(appliedRate);
    default:
      return ZERO;
  }
}

export function computeBuildup(
  rows: BuildUpRow[],
  qsItems: QSItem[] | Map<string, QSItem>,
  library: LibraryRate[] | Map<string, LibraryRate>,
): RowResult[] {
  const qs = qsItems instanceof Map ? qsItems : new Map(qsItems.map((q) => [q.code, q]));
  const lib = library instanceof Map ? library : new Map(library.map((r) => [r.code, r]));

  const seq = new Map<string, number>();
  // Operator and fuel double-count checks look across rows of the same QS code.
  const labourOperator = new Map<string, number>();
  const fuelRows = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  for (const r of rows) {
    const desc = (lib.get(r.resourceCode)?.description ?? "").toLowerCase();
    if (r.resourceType === "Labour" && desc.includes("operator")) bump(labourOperator, r.qsCode);
    if (desc.includes("fuel")) bump(fuelRows, r.qsCode);
  }

  const out: RowResult[] = [];
  for (const r of rows) {
    if (!r.qsCode) continue;
    if (!MODES.includes(r.mode)) throw new BuildUpError(`Unknown calculation mode '${r.mode}' on ${r.qsCode}`);
    bump(seq, r.qsCode);
    const rowId = `${r.qsCode}-${String(seq.get(r.qsCode)).padStart(3, "0")}`;

    const q = qs.get(r.qsCode);
    const qty = q ? d(q.quantity) : ZERO;
    const libRec = lib.get(r.resourceCode);
    const libRate = libRec ? d(libRec.baseRate) : ZERO;
    const unit = libRec?.unit ?? "";

    const prod = d(r.productivityRate);
    const calcHrs = prod.isZero() ? null : qty.div(prod);
    const override = d(r.durationOverrideHrs);
    const appliedHrs = override.gt(0) ? override : (calcHrs ?? ZERO);
    const rateOverride = d(r.jobRateOverride);
    const appliedRate = rateOverride.gt(0) ? rateOverride : libRate;
    const cost = rowCost(r, qty, appliedHrs, appliedRate);

    const exposed = r.weatherExposed === "Yes" && (r.resourceType === "Labour" || r.resourceType === "Plant") ? cost : ZERO;

    let flag: string;
    if (r.resourceCode === "" && r.mode !== MODE_LUMP) flag = "RESOURCE CODE";
    else if (appliedRate.isZero()) flag = "RATE MISSING";
    else if (r.resourceType === "Plant" && libRec && libRec.operatorIncluded === "Yes" && (labourOperator.get(r.qsCode) ?? 0) > 0)
      flag = "OPERATOR DOUBLE-COUNT";
    else if (r.resourceType === "Plant" && libRec && libRec.fuelIncluded === "Yes" && (fuelRows.get(r.qsCode) ?? 0) > 0)
      flag = "FUEL DOUBLE-COUNT";
    else if (r.verified !== "Yes") flag = "VERIFY";
    else flag = "OK";

    out.push({
      rowId, qsCode: r.qsCode, qsQty: qty, calcDurationHrs: calcHrs, appliedDurationHrs: appliedHrs,
      libraryRate: libRate, appliedRate, unit, cost, weatherExposedCost: exposed, qaFlag: flag,
    });
  }
  return out;
}
