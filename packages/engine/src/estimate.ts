/**
 * Estimate pricing, ported from Blackline QSi (backend/services/estimate_engine.py and
 * pricing_engine.py) onto decimal arithmetic.
 *
 *   cost base         direct cost of included zones / tasks / resources, each line rounded to the cent
 *   + risk allowance  rows of (% of a basis); basis is the whole cost base or a set of categories
 *   + register risks  expected values of risks ticked "include in pricing"
 *   + overhead        % of cost base
 *   = total before profit
 *   / (1 - margin%)   = sell price ex GST, then GST on top
 *
 * Opportunities are shown but never change the price.
 */
import { cents, D, type Dec, ZERO } from "./money.js";
import type {
  EstimateInput,
  LegacyRiskConfig,
  Num,
  RegisterItem,
  ResourceLine,
  RiskLine,
} from "./types.js";

export const TOTAL = "total";

const num = (x: Num): Dec => new D(x === null || x === undefined || x === "" ? 0 : String(x));
const included = (item: { included_in_total?: boolean | null }) =>
  item.included_in_total === undefined || item.included_in_total === null ? true : !!item.included_in_total;

const LABOUR = ["labour", "labor", "labours"];
const MATERIAL = ["material", "materials"];
const SUBCONTRACTOR = ["subcontractor", "subcontractors", "sub", "subcontract"];
const PLANT = ["plant", "plant/equipment", "plant hire", "plant_hire", "equipment", "plant & equipment"];

/** Built-in categories collapse to a key; anything else is a custom category kept under its own name. */
export function normalizeCategory(raw: string | undefined): { key: string; custom: boolean } {
  if (!raw) return { key: "other", custom: false };
  const c = raw.toLowerCase().trim();
  if (LABOUR.includes(c)) return { key: "labour", custom: false };
  if (MATERIAL.includes(c)) return { key: "material", custom: false };
  if (SUBCONTRACTOR.includes(c)) return { key: "subcontractor", custom: false };
  if (PLANT.includes(c)) return { key: "plant", custom: false };
  return { key: raw, custom: true };
}

export interface CostBase {
  directCost: Dec;
  excludedCost: Dec;
  costBase: Dec;
  categoryTotals: Map<string, Dec>;
}

const lineCost = (r: ResourceLine) => cents(num(r.qty).times(num(r.rate)));

export function buildCostBase(est: EstimateInput): CostBase {
  const cat = new Map<string, Dec>(["labour", "material", "subcontractor", "plant", "other"].map((k) => [k, ZERO]));
  let direct = ZERO;
  let excluded = ZERO;

  const add = (r: ResourceLine, cost: Dec) => {
    const { key } = normalizeCategory(r.category || r.type || "");
    cat.set(key, (cat.get(key) ?? ZERO).plus(cost));
  };

  for (const zone of est.zones ?? []) {
    const zoneIn = included(zone);
    for (const task of zone.tasks ?? []) {
      const taskIn = included(task);
      for (const r of task.resources ?? []) {
        const cost = lineCost(r);
        if (zoneIn && taskIn && included(r)) {
          add(r, cost);
          direct = direct.plus(cost);
        } else {
          excluded = excluded.plus(cost);
        }
      }
    }
  }

  for (const item of est.line_items ?? []) {
    const cost = lineCost(item);
    if (included(item)) {
      add(item, cost);
      direct = direct.plus(cost);
    } else {
      excluded = excluded.plus(cost);
    }
  }

  return { directCost: direct, excludedCost: excluded, costBase: cents(direct), categoryTotals: cat };
}

// ---- risk -----------------------------------------------------------------

/** The fixed lines of QSi's original "detailed risk" panel, in order. */
const LEGACY_ALLOWANCES: [string, string, string[] | null][] = [
  ["labour", "Labour allowance", ["labour"]],
  ["material", "Material allowance", ["material"]],
  ["subcontractor", "Subcontractor allowance", ["subcontractor"]],
  ["plant", "Plant & equipment allowance", ["plant"]],
  ["weather", "Weather allowance", ["plant", "labour"]],
  ["sundries", "Sundries allowance", ["labour", "material", "plant"]],
  ["design", "Design allowance", [TOTAL]],
  ["trueUnknowns", "True unknowns", [TOTAL]],
  ["custom", "Custom allowance 1", [TOTAL]],
  ["custom2", "Custom allowance 2", [TOTAL]],
  ["additional1", "Additional risk 1", null],
  ["additional2", "Additional risk 2", null],
  ["additional3", "Additional risk 3", null],
];
const OPPORTUNITY_KEYS = ["opportunity1", "opportunity2", "opportunity3"];

export function legacyToRiskLines(est: EstimateInput): RiskLine[] {
  const settings = est.detailed_risk_settings;
  if (!(est.use_detailed_risk && settings && Object.keys(settings).length > 0)) {
    return [
      {
        id: "general",
        legacy_key: "general",
        name: "General allowance",
        kind: "allowance",
        basis: [TOTAL],
        percent: est.risk_allowance_percent ?? 5,
        enabled: true,
      },
    ];
  }
  const rows: RiskLine[] = [];
  for (const [key, name, basis] of LEGACY_ALLOWANCES) {
    const cfg: LegacyRiskConfig = settings[key] ?? {};
    if (!cfg.enabled) continue;
    rows.push({
      id: `legacy-${key}`,
      legacy_key: key,
      kind: "allowance",
      name: cfg.name || name,
      basis: basis === null ? [cfg.linkedCategory ?? ""] : [...basis],
      percent: cfg.percent || 0,
      enabled: true,
    });
  }
  OPPORTUNITY_KEYS.forEach((key, i) => {
    const cfg: LegacyRiskConfig = settings[key] ?? {};
    if (!cfg.enabled) return;
    const linked = cfg.linkedCategory || "";
    rows.push({
      id: `legacy-${key}`,
      legacy_key: key,
      kind: "opportunity",
      name: cfg.name || `Opportunity ${i + 1}`,
      basis: linked ? [linked] : [TOTAL],
      percent: cfg.percent || 0,
      enabled: true,
    });
  });
  return rows;
}

export interface RiskRowResult {
  id?: string;
  name?: string;
  basis: string[];
  percent: Dec;
  base: Dec;
  amount: Dec;
}

export interface RiskResult {
  amount: Dec;
  lines: RiskRowResult[];
  opportunitiesTotal: Dec;
  opportunityLines: RiskRowResult[];
}

export function priceRiskLines(lines: RiskLine[], categories: Map<string, Dec>, costBase: Dec): RiskResult {
  const allowances: RiskRowResult[] = [];
  const opportunities: RiskRowResult[] = [];
  let allowanceTotal = ZERO;
  let opportunityTotal = ZERO;

  for (const line of lines) {
    if (line.enabled === false) continue;
    const percent = num(line.percent);
    const basis = line.basis ?? [];
    const base = basis.includes(TOTAL)
      ? costBase
      : basis.reduce((t, c) => t.plus(categories.get(c) ?? ZERO), ZERO);
    const amount = cents(base.times(percent).div(100));
    const row: RiskRowResult = { id: line.id, name: line.name, basis: [...basis], percent, base, amount };
    if (line.kind === "opportunity") {
      opportunityTotal = opportunityTotal.plus(amount);
      opportunities.push(row);
    } else {
      allowanceTotal = allowanceTotal.plus(amount);
      allowances.push(row);
    }
  }
  return {
    amount: cents(allowanceTotal),
    lines: allowances,
    opportunitiesTotal: cents(opportunityTotal),
    opportunityLines: opportunities,
  };
}

export interface RegisterSummary {
  included: Dec;
  excluded: Dec;
  opportunitiesShown: Dec;
  opportunitiesReference: Dec;
}

/** Project risk register: only active, open risks ticked "include in pricing" are priced. */
export function summariseRegister(risks: RegisterItem[]): RegisterSummary {
  let inc = ZERO;
  let exc = ZERO;
  let shown = ZERO;
  let ref = ZERO;
  for (const r of risks) {
    const active = r.is_active ?? r.is_financially_active ?? true;
    if (!active || (r.status ?? "identified") === "closed") continue;
    const ev = num(r.expected_value);
    const selected = !!r.include_in_pricing;
    if ((r.item_type ?? "risk") === "opportunity") {
      if (selected) shown = shown.plus(ev);
      else ref = ref.plus(ev);
    } else if (selected) inc = inc.plus(ev);
    else exc = exc.plus(ev);
  }
  return {
    included: cents(inc),
    excluded: cents(exc),
    opportunitiesShown: cents(shown),
    opportunitiesReference: cents(ref),
  };
}

// ---- totals ---------------------------------------------------------------

export interface EstimateTotals {
  directCost: Dec;
  excludedCost: Dec;
  fullPotentialDirectCost: Dec;
  costBase: Dec;
  categoryTotals: Map<string, Dec>;
  risk: RiskResult;
  registerIncluded: Dec;
  registerExcluded: Dec;
  registerOpportunitiesNotPriced: Dec;
  overhead: Dec;
  totalBeforeProfit: Dec;
  profit: Dec;
  sellExGst: Dec;
  gst: Dec;
  totalIncGst: Dec;
  /** Gross margin on sell, percent to 2dp. */
  grossMarginPct: Dec;
}

export function calculateEstimate(est: EstimateInput, register: RegisterItem[] = []): EstimateTotals {
  const cb = buildCostBase(est);
  const costBase = cb.costBase;

  const rows = est.risk_lines ?? legacyToRiskLines(est);
  const risk = priceRiskLines(rows, cb.categoryTotals, costBase);

  const reg = summariseRegister(register);
  const overheadPct = num(est.overhead_percent ?? 10);
  const overhead = cents(costBase.times(overheadPct).div(100));

  const marginPct = num(est.profit_margin_percent ?? 15);
  const totalBeforeProfit = costBase.plus(risk.amount).plus(reg.included).plus(overhead);
  const sell = marginPct.lt(100) ? cents(totalBeforeProfit.div(new D(1).minus(marginPct.div(100)))) : totalBeforeProfit;
  const profit = cents(sell.minus(totalBeforeProfit));

  const gst = cents(sell.times(num(est.gst_percent ?? 15)).div(100));
  const totalIncGst = cents(sell.plus(gst));
  const grossMarginPct = sell.gt(0) ? sell.minus(costBase).div(sell).times(100).toDecimalPlaces(2, D.ROUND_HALF_UP) : ZERO;

  return {
    directCost: cents(cb.directCost),
    excludedCost: cents(cb.excludedCost),
    fullPotentialDirectCost: cents(cb.directCost.plus(cb.excludedCost)),
    costBase,
    categoryTotals: cb.categoryTotals,
    risk,
    registerIncluded: reg.included,
    registerExcluded: reg.excluded,
    registerOpportunitiesNotPriced: reg.opportunitiesShown,
    overhead,
    totalBeforeProfit,
    profit,
    sellExGst: sell,
    gst,
    totalIncGst,
    grossMarginPct,
  };
}
