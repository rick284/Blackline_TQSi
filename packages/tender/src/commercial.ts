/**
 * Tender Build-Up commercial layer (Commercial Inputs CA01..CA25).
 *
 * Pre-margin additions (CA01..CA16), each only when Include? = Yes:
 *   Risk Engine / Weather Engine -> value delivered by that engine
 *   PC Sum / Fixed Amount        -> entered amount
 *   %                            -> base direct x %
 * Subtotal = base direct + pre-margin additions.
 * CA17 overhead  : Markup % -> subtotal x %  | Fixed Amount -> amount
 * CA18 profit    : Margin % -> (S+OH+CA19+CA20)/(1-m) - (S+OH+CA19+CA20)   [TRUE MARGIN]
 *                  Markup % -> base x %      | Fixed Amount -> amount
 * CA19 bonds, CA20 retention finance: % of subtotal | PC Sum
 * Tender total = subtotal + commercial adjustments. GST optional (CA21).
 * Retention (CA22..CA25) is cashflow visibility only.
 */
import { type Dec, ZERO } from "@blackline/engine";
import { type CommercialInput, d } from "./models.js";

const ONE = d(1);

export const PRE_MARGIN_REFS = Array.from({ length: 16 }, (_, i) => `CA${String(i + 1).padStart(2, "0")}`);
/** Allowance lines added by the estimator (CX01, CX02 ...): a % of base direct or a PC sum, before overhead and margin. */
export const CUSTOM_PREFIX = "CX";

export const isCustom = (ref: string) => ref.startsWith(CUSTOM_PREFIX);
export const isPreMargin = (ref: string) => PRE_MARGIN_REFS.includes(ref) || isCustom(ref);

/** Bases a line may be switched between (empty = set by the platform). */
export const COMMERCIAL_METHODS: Record<string, string[]> = {
  ...Object.fromEntries([3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 19, 20].map((n) => [`CA${String(n).padStart(2, "0")}`, ["%", "PC Sum"]])),
  CA01: ["Risk Engine", "%", "PC Sum"],
  CA02: ["Risk Engine", "%", "PC Sum"],
  CA17: ["Markup %", "Fixed Amount"],
  CA18: ["Margin %", "Markup %", "Fixed Amount"],
};

export const methodsFor = (ref: string) => (isCustom(ref) ? ["%", "PC Sum"] : (COMMERCIAL_METHODS[ref] ?? []));

export interface TenderResult {
  baseDirect: Dec;
  additions: Map<string, Dec>;
  preMarginTotal: Dec;
  subtotal: Dec;
  overhead: Dec;
  profit: Dec;
  bonds: Dec;
  retentionFinance: Dec;
  commercialTotal: Dec;
  tenderExclGst: Dec;
  gst: Dec;
  tenderInclGst: Dec;
  retentionWithheld: Dec;
  netAfterRetention: Dec;
}

export type ByRef = Map<string, CommercialInput>;
const byRefOf = (inputs: CommercialInput[]): ByRef => new Map(inputs.map((c) => [c.ref, c]));

/**
 * The one place overhead, profit, bonds and retention finance are applied to a cost base (the own-works
 * subtotal, or the whole consolidated package). Honours each line's include switch and basis. Profit is
 * charged on base + overhead + bonds + finance.
 */
export function priceStack(costIn: Dec, byRef: ByRef) {
  const cost = d(costIn);

  const pctOrPc = (ref: string): Dec => {
    const c = byRef.get(ref);
    if (!c || c.include !== "Yes") return ZERO;
    if (c.method === "%") return cost.times(d(c.pct));
    if (c.method === "PC Sum") return d(c.pcSum);
    return ZERO;
  };

  const bonds = pctOrPc("CA19");
  const retentionFinance = pctOrPc("CA20");

  let overhead = ZERO;
  const oh = byRef.get("CA17");
  if (oh && oh.include === "Yes") {
    if (oh.method === "Markup %") overhead = cost.times(d(oh.pct));
    else if (oh.method === "Fixed Amount") overhead = d(oh.pcSum);
  }

  let profit = ZERO;
  const pr = byRef.get("CA18");
  if (pr && pr.include === "Yes") {
    const costBase = cost.plus(overhead).plus(bonds).plus(retentionFinance);
    if (pr.method === "Margin %") {
      const m = d(pr.pct);
      if (m.gte(1)) throw new Error("Margin must be below 100%");
      profit = costBase.div(ONE.minus(m)).minus(costBase);
    } else if (pr.method === "Markup %") profit = costBase.times(d(pr.pct));
    else if (pr.method === "Fixed Amount") profit = d(pr.pcSum);
  }
  return { overhead, profit, bonds, retentionFinance };
}

/**
 * The commercial stack as a straight line: sell = a x cost + b, where b is the part that does not move
 * with cost (fixed overhead, profit, bond or finance amounts, carried through the margin). Used to share a
 * package's price between client schedule groups so the groups add up to the package exactly:
 * group sell = a x group cost + b x (group cost / package cost).
 */
export function packageSellLine(byRef: ByRef): { a: Dec; b: Dec } {
  const sell = (c: Dec) => {
    const s = priceStack(c, byRef);
    return c.plus(s.overhead).plus(s.profit).plus(s.bonds).plus(s.retentionFinance);
  };
  const b = sell(ZERO);
  return { a: sell(ONE).minus(b), b };
}

function preMarginAmount(ci: CommercialInput, base: Dec): Dec {
  if (ci.include !== "Yes") return ZERO;
  switch (ci.method) {
    case "Risk Engine":
    case "Weather Engine":
    case "Management Reserve":
      return d(ci.engineValue);
    case "PC Sum":
    case "Fixed Amount":
      return d(ci.pcSum);
    case "%":
      return base.times(d(ci.pct));
    default:
      return ZERO;
  }
}

export function computeTender(baseDirect: Dec, inputs: CommercialInput[]): TenderResult {
  const byRef = byRefOf(inputs);
  const base = d(baseDirect);

  const additions = new Map<string, Dec>();
  for (const c of inputs) if (isPreMargin(c.ref)) additions.set(c.ref, preMarginAmount(c, base));
  const pre = [...additions.values()].reduce((t, v) => t.plus(v), ZERO);
  const subtotal = base.plus(pre);

  const { overhead, profit, bonds, retentionFinance } = priceStack(subtotal, byRef);
  const commercial = overhead.plus(profit).plus(bonds).plus(retentionFinance);
  const total = subtotal.plus(commercial);

  const gstIn = byRef.get("CA21");
  const gst = gstIn && gstIn.include === "Yes" ? total.times(d(gstIn.pct)) : ZERO;

  // Retention: cashflow visibility only (CA22 rate, CA24 deposit offset, CA25 deposit-retention flag)
  const retIn = byRef.get("CA22");
  const depIn = byRef.get("CA24");
  const depRet = byRef.get("CA25");
  let retention = ZERO;
  if (retIn && retIn.include === "Yes") {
    const offset = depIn && depIn.include === "Yes" && !(depRet && depRet.include === "Yes") ? d(depIn.pct) : ZERO;
    retention = total.times(d(retIn.pct)).times(ONE.minus(offset));
  }

  return {
    baseDirect: base, additions, preMarginTotal: pre, subtotal, overhead, profit, bonds, retentionFinance,
    commercialTotal: commercial, tenderExclGst: total, gst, tenderInclGst: total.plus(gst),
    retentionWithheld: retention, netAfterRetention: total.minus(retention),
  };
}
