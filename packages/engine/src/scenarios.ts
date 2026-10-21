/**
 * Full-potential scenario, inline variations and contract value, ported from QSi
 * (pricing_engine.py `_calculate_full_potential`, `_price_variations`, `_build_estimate_summary`,
 * and variation_engine.py).
 */
import { calculateEstimate, type EstimateTotals } from "./estimate.js";
import { cents, D, type Dec, ZERO } from "./money.js";
import type { EstimateInput, Num, RegisterItem } from "./types.js";

const num = (x: Num): Dec => new D(x === null || x === undefined || x === "" ? 0 : String(x));

/** The same pricing with every zone, task, resource and line switched back to included. */
export function fullPotential(est: EstimateInput, register: RegisterItem[] = []): EstimateTotals {
  const clone: EstimateInput = structuredClone(est);
  for (const z of clone.zones ?? []) {
    z.included_in_total = true;
    for (const t of z.tasks ?? []) {
      t.included_in_total = true;
      for (const r of t.resources ?? []) r.included_in_total = true;
    }
  }
  for (const li of clone.line_items ?? []) li.included_in_total = true;
  return calculateEstimate(clone, register);
}

export type VariationStatus =
  | "draft" | "costed" | "submitted" | "approved" | "rejected"
  | "disputed" | "ready_to_claim" | "claimed" | "paid" | "closed";

export interface VariationInput extends EstimateInput {
  status?: string;
  override_pricing_settings?: boolean;
  include_in_contract_total?: boolean;
  include_in_internal_forecast?: boolean;
}

export interface PricedVariation {
  input: VariationInput;
  totals: EstimateTotals;
  effective: { riskPct: Dec; overheadPct: Dec; marginPct: Dec; gstPct: Dec };
}

/**
 * Each variation is priced by the same engine. The project risk register is never applied.
 * Without an override it inherits the base general risk %, overhead %, margin % and GST %.
 * Detailed risk is never inherited.
 */
export function priceVariations(variations: VariationInput[], base: EstimateInput): PricedVariation[] {
  return variations.map((v) => {
    const override = !!v.override_pricing_settings;
    const risk = override ? (v.risk_allowance_percent ?? 0) : (base.risk_allowance_percent ?? 5);
    const oh = override ? (v.overhead_percent ?? 0) : (base.overhead_percent ?? 10);
    const margin = override ? (v.profit_margin_percent ?? 0) : (base.profit_margin_percent ?? 15);
    const gst = override ? (v.gst_percent ?? base.gst_percent ?? 15) : (base.gst_percent ?? 15);
    const input: EstimateInput = {
      zones: v.zones ?? [],
      line_items: v.line_items ?? [],
      risk_allowance_percent: risk,
      overhead_percent: oh,
      profit_margin_percent: margin,
      gst_percent: gst,
      use_detailed_risk: false,
      detailed_risk_settings: null,
    };
    return {
      input: v,
      totals: calculateEstimate(input),
      effective: { riskPct: num(risk), overheadPct: num(oh), marginPct: num(margin), gstPct: num(gst) },
    };
  });
}

export interface EstimateSummary {
  baseSellExGst: Dec;
  baseTotalIncGst: Dec;
  baseDirectCost: Dec;
  statusTotals: Record<string, Dec>;
  statusCounts: Record<string, number>;
  approvedVariationsTotal: Dec;
  contractVariationsTotal: Dec;
  internalForecastVariationsTotal: Dec;
  currentContractValue: Dec;
  internalForecastTotal: Dec;
  variationCount: number;
}

const STATUSES: VariationStatus[] = [
  "draft", "costed", "submitted", "approved", "rejected", "disputed", "ready_to_claim", "claimed", "paid", "closed",
];

export function summariseEstimate(base: EstimateTotals, variations: PricedVariation[]): EstimateSummary {
  const statusTotals = Object.fromEntries(STATUSES.map((s) => [s, ZERO])) as Record<string, Dec>;
  const statusCounts = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<string, number>;
  let contract = ZERO;
  let forecast = ZERO;
  let approved = ZERO;

  for (const { input, totals } of variations) {
    const status = (input.status || "draft").toLowerCase();
    const sell = totals.sellExGst;
    if (status in statusTotals) {
      statusTotals[status] = statusTotals[status]!.plus(sell);
      statusCounts[status]! += 1;
    }
    if (input.include_in_contract_total && status === "approved") contract = contract.plus(sell);
    if (input.include_in_internal_forecast ?? true) forecast = forecast.plus(sell);
    if (status === "approved") approved = approved.plus(sell);
  }

  return {
    baseSellExGst: cents(base.sellExGst),
    baseTotalIncGst: cents(base.totalIncGst),
    baseDirectCost: cents(base.directCost),
    statusTotals: Object.fromEntries(Object.entries(statusTotals).map(([k, v]) => [k, cents(v)])),
    statusCounts,
    approvedVariationsTotal: cents(approved),
    contractVariationsTotal: cents(contract),
    internalForecastVariationsTotal: cents(forecast),
    currentContractValue: cents(base.sellExGst.plus(contract)),
    internalForecastTotal: cents(base.sellExGst.plus(forecast)),
    variationCount: variations.length,
  };
}

export interface ContractVariation {
  status?: string;
  type?: "variation" | "daywork" | "credit" | string;
  amount_ex_gst?: Num;
}

/** Current contract value = base sell + approved additions (variations, dayworks) - approved credits. */
export function currentContractValue(sellExGst: Dec, variations: ContractVariation[], gstRate: Num) {
  let add = ZERO;
  let credits = ZERO;
  for (const v of variations) {
    if (v.status !== "approved") continue;
    if (v.type === "variation" || v.type === "daywork") add = add.plus(num(v.amount_ex_gst));
    else if (v.type === "credit") credits = credits.plus(num(v.amount_ex_gst));
  }
  const current = cents(sellExGst.plus(add).minus(credits));
  return {
    originalContractValue: cents(sellExGst),
    currentContractValue: current,
    currentContractValueIncGst: cents(current.times(new D(1).plus(num(gstRate)))),
    approvedAdditions: cents(add),
    approvedCredits: cents(credits),
  };
}
