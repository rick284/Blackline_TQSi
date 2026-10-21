/**
 * Consolidated Package: own works (pre-commercial, incl. Management Reserve) + subcontract overlays added
 * ONCE, less confirmed overlap; overhead and TRUE-MARGIN profit applied across the whole package.
 * Gross margin is measured on sell.
 */
import { type Dec, ZERO } from "@blackline/engine";
import { priceStack, type ByRef } from "./commercial.js";
import { type CommercialInput, d, type Num, type Overlay } from "./models.js";

export interface ConsolidatedResult {
  ownWorks: Dec;
  overlaysTotal: Dec;
  /** Own plus overlays, before overlap */
  grossKnownPackage: Dec;
  confirmedOverlap: Dec;
  knownAfterOverlap: Dec;
  overhead: Dec;
  subtotalAfterOverhead: Dec;
  profit: Dec;
  /** Working all-in (gross package basis, as the workbook) */
  allInTender: Dec;
  grossMarginOnSell: Dec;
  allInIfOverlapRemoved: Dec;
  bonds: Dec;
  retentionFinance: Dec;
}

function price(cost: Dec, byRef: ByRef) {
  const s = priceStack(cost, byRef);
  const sub = cost.plus(s.overhead).plus(s.bonds).plus(s.retentionFinance);
  return { overhead: s.overhead, sub, profit: s.profit, total: sub.plus(s.profit) };
}

/**
 * Pass `commercial` (the tender's commercial inputs) so the package carries exactly the overhead, profit, bond
 * and finance choices the own-works tender uses: one authority, `priceStack`. The older rate-only form
 * (`rates`) means markup-% overhead and true-margin profit, both on.
 */
export function computeConsolidated(
  ownWorksPrecommercial: Dec,
  overlays: Overlay[],
  confirmedOverlap: Num,
  opts: { commercial?: CommercialInput[]; rates?: { overheadRate: Num; margin: Num } },
): ConsolidatedResult {
  let byRef: ByRef;
  if (opts.commercial) byRef = new Map(opts.commercial.map((c) => [c.ref, c]));
  else if (opts.rates) {
    if (d(opts.rates.margin).gte(1)) throw new Error("Margin must be below 100%");
    byRef = new Map<string, CommercialInput>([
      ["CA17", { ref: "CA17", name: "Overhead", method: "Markup %", include: "Yes", pct: opts.rates.overheadRate }],
      ["CA18", { ref: "CA18", name: "Profit", method: "Margin %", include: "Yes", pct: opts.rates.margin }],
    ]);
  } else throw new Error("Give the commercial inputs, or an overhead rate and a margin.");

  const own = d(ownWorksPrecommercial);
  const ov = overlays.reduce((t, o) => t.plus(d(o.amount)), ZERO);
  const gross = own.plus(ov);
  const overlap = d(confirmedOverlap);
  const after = gross.minus(overlap);
  const main = price(gross, byRef);
  const reduced = price(after, byRef);
  const stack = priceStack(gross, byRef);
  const gm = main.total.isZero() ? ZERO : main.total.minus(gross).div(main.total);

  return {
    ownWorks: own, overlaysTotal: ov, grossKnownPackage: gross, confirmedOverlap: overlap, knownAfterOverlap: after,
    overhead: main.overhead, subtotalAfterOverhead: main.sub, profit: main.profit, allInTender: main.total,
    grossMarginOnSell: gm, allInIfOverlapRemoved: reduced.total, bonds: stack.bonds, retentionFinance: stack.retentionFinance,
  };
}
