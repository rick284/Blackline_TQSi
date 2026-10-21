/**
 * Commercial control (budget, forecast, earned value, programme), ported from QSi
 * services/commercial_control_engine.py. Warning generation is not ported yet.
 */
import { cents, D, type Dec, ZERO } from "./money.js";
import type { Num } from "./types.js";

const num = (x: Num): Dec => new D(x === null || x === undefined || x === "" ? 0 : String(x));
const pct2 = (x: Dec) => x.toDecimalPlaces(2, D.ROUND_HALF_UP);
const max0 = (x: Dec) => (x.lt(0) ? ZERO : x);

export interface BudgetLine {
  id?: string;
  original_total_cost?: Num;
  original_sell_value?: Num;
  approved_variation_cost_adjustment?: Num;
  approved_variation_sell_adjustment?: Num;
  actual_cost_to_date?: Num;
  committed_cost?: Num;
  /** Manual forecast. When null or absent it is computed from the revised budget. */
  forecast_cost_to_complete?: Num;
  original_labour_hours?: Num;
  [k: string]: unknown;
}

export type BudgetStatus = "Over Budget" | "Watch" | "Tracking OK";

export interface BudgetLineSummary {
  revisedBudgetCost: Dec;
  revisedSellValue: Dec;
  forecastCostToComplete: Dec;
  forecastFinalCost: Dec;
  costVarianceToOriginal: Dec;
  costVarianceToRevised: Dec;
  marginVariance: Dec;
  budgetRemaining: Dec;
  status: BudgetStatus;
}

export function budgetLineSummary(line: BudgetLine): BudgetLineSummary {
  const originalCost = num(line.original_total_cost);
  const originalSell = num(line.original_sell_value);
  const actual = num(line.actual_cost_to_date);
  const committed = num(line.committed_cost);

  const revisedCost = cents(originalCost.plus(num(line.approved_variation_cost_adjustment)));
  const revisedSell = cents(originalSell.plus(num(line.approved_variation_sell_adjustment)));

  const manual = line.forecast_cost_to_complete;
  const ctc =
    manual !== null && manual !== undefined
      ? num(manual)
      : max0(cents(revisedCost.minus(actual).minus(committed)));

  const finalCost = cents(actual.plus(committed).plus(ctc));

  let status: BudgetStatus;
  if (finalCost.gt(revisedCost.times("1.05"))) status = "Over Budget";
  else if (finalCost.gt(revisedCost)) status = "Watch";
  else if (actual.plus(committed).gt(revisedCost)) status = "Over Budget";
  else status = "Tracking OK";

  return {
    revisedBudgetCost: revisedCost,
    revisedSellValue: revisedSell,
    forecastCostToComplete: cents(ctc),
    forecastFinalCost: finalCost,
    costVarianceToOriginal: cents(originalCost.minus(finalCost)),
    costVarianceToRevised: cents(revisedCost.minus(finalCost)),
    marginVariance: revisedSell.gt(0) ? cents(revisedSell.minus(finalCost)) : ZERO,
    budgetRemaining: cents(revisedCost.minus(actual).minus(committed)),
    status,
  };
}

export interface ActualCost {
  amount_ex_gst?: Num;
  labour_hours?: Num;
  commercial_budget_line_id?: string | null;
}

export interface Commitment {
  committed_amount_ex_gst?: Num;
  commercial_budget_line_id?: string | null;
}

export interface CommercialProfile {
  original_contract_value_ex_gst?: Num;
  original_budget_cost?: Num;
  original_margin_amount?: Num;
  original_margin_percentage?: Num;
}

export interface ProjectSummary {
  originalContractValue: Dec;
  currentContractValue: Dec;
  forecastFinalRevenue: Dec;
  approvedVariationsSell: Dec;
  pendingVariationsSell: Dec;
  forecastVariationsSell: Dec;
  originalBudget: Dec;
  revisedBudget: Dec;
  actualCostToDate: Dec;
  committedCost: Dec;
  forecastCostToComplete: Dec;
  forecastFinalCost: Dec;
  budgetRemaining: Dec;
  costVariance: Dec;
  originalProfit: Dec;
  originalMarginPct: Dec;
  currentProfit: Dec;
  currentMarginPct: Dec;
  forecastFinalProfit: Dec;
  forecastFinalMarginPct: Dec;
  marginDrift: Dec;
  originalLabourHours: Dec;
  actualLabourHours: Dec;
  labourBurnPct: Dec;
  unallocatedCostTotal: Dec;
  unallocatedCommitmentTotal: Dec;
  lines: (BudgetLine & { summary: BudgetLineSummary })[];
}

export function projectSummary(
  budgetLines: BudgetLine[],
  actualCosts: ActualCost[],
  commitments: Commitment[],
  profile: CommercialProfile,
  approvedVariationsSell: Num = 0,
  pendingVariationsSell: Num = 0,
  forecastVariationsSell: Num = 0,
): ProjectSummary {
  const originalCv = num(profile.original_contract_value_ex_gst);
  const originalBudget = num(profile.original_budget_cost);
  const profileMarginPct = num(profile.original_margin_percentage);
  const approved = num(approvedVariationsSell);
  const pending = num(pendingVariationsSell);
  const forecastVar = num(forecastVariationsSell);

  const currentCv = cents(originalCv.plus(approved));
  const forecastRevenue = cents(originalCv.plus(approved).plus(pending).plus(forecastVar));

  let origCost = ZERO, revCost = ZERO, actual = ZERO, committed = ZERO, ctc = ZERO, finalCost = ZERO;
  let origHours = ZERO, actualHours = ZERO;
  const lines: ProjectSummary["lines"] = [];

  for (const line of budgetLines) {
    const s = budgetLineSummary(line);
    origCost = origCost.plus(num(line.original_total_cost));
    revCost = revCost.plus(s.revisedBudgetCost);
    actual = actual.plus(num(line.actual_cost_to_date));
    committed = committed.plus(num(line.committed_cost));
    ctc = ctc.plus(s.forecastCostToComplete);
    finalCost = finalCost.plus(s.forecastFinalCost);
    origHours = origHours.plus(num(line.original_labour_hours));
    lines.push({ ...line, summary: s });
  }
  for (const ac of actualCosts) actualHours = actualHours.plus(num(ac.labour_hours));

  const unallocatedCost = actualCosts
    .filter((a) => !a.commercial_budget_line_id)
    .reduce((t, a) => t.plus(num(a.amount_ex_gst)), ZERO);
  const unallocatedCommit = commitments
    .filter((c) => !c.commercial_budget_line_id)
    .reduce((t, c) => t.plus(num(c.committed_amount_ex_gst)), ZERO);

  origCost = cents(origCost);
  revCost = cents(revCost);
  actual = cents(actual);
  committed = cents(committed);
  ctc = cents(ctc);
  finalCost = cents(finalCost);

  const effectiveOriginalBudget = originalBudget.gt(0) ? originalBudget : origCost;

  const originalProfit = cents(originalCv.minus(effectiveOriginalBudget));
  const originalMarginCalc = originalCv.gt(0) ? pct2(originalProfit.div(originalCv).times(100)) : ZERO;
  const originalMargin = profileMarginPct.gt(0) ? profileMarginPct : originalMarginCalc;

  const currentProfit = cents(currentCv.minus(revCost));
  const currentMargin = currentCv.gt(0) ? pct2(currentProfit.div(currentCv).times(100)) : ZERO;

  const forecastProfit = cents(forecastRevenue.minus(finalCost));
  const forecastMargin = forecastRevenue.gt(0) ? pct2(forecastProfit.div(forecastRevenue).times(100)) : ZERO;

  return {
    originalContractValue: originalCv,
    currentContractValue: currentCv,
    forecastFinalRevenue: forecastRevenue,
    approvedVariationsSell: cents(approved),
    pendingVariationsSell: cents(pending),
    forecastVariationsSell: cents(forecastVar),
    originalBudget: effectiveOriginalBudget,
    revisedBudget: revCost,
    actualCostToDate: actual,
    committedCost: committed,
    forecastCostToComplete: ctc,
    forecastFinalCost: finalCost,
    budgetRemaining: cents(revCost.minus(actual).minus(committed)),
    costVariance: cents(revCost.minus(finalCost)),
    originalProfit,
    originalMarginPct: originalMargin,
    currentProfit,
    currentMarginPct: currentMargin,
    forecastFinalProfit: forecastProfit,
    forecastFinalMarginPct: forecastMargin,
    marginDrift: pct2(forecastMargin.minus(originalMargin)),
    originalLabourHours: origHours,
    actualLabourHours: actualHours,
    labourBurnPct: origHours.gt(0) ? pct2(actualHours.div(origHours).times(100)) : ZERO,
    unallocatedCostTotal: cents(unallocatedCost),
    unallocatedCommitmentTotal: cents(unallocatedCommit),
    lines,
  };
}

// ---- earned value and programme --------------------------------------------

export interface EarnedValue {
  revisedBudgetValue: Dec;
  plannedValue: Dec;
  earnedValue: Dec;
  actualCostToDate: Dec;
  committedCost: Dec;
  forecastCostToComplete: Dec;
  forecastFinalCost: Dec;
  costVariance: Dec;
  scheduleVariance: Dec;
  cpi: Dec | null;
  spi: Dec | null;
  labourHoursAllowed: Dec;
  labourHoursUsed: Dec;
  labourHoursEarned: Dec;
  labourProductivityVariance: Dec;
}

export function earnedValue(
  line: BudgetLine & { revised_budget_cost?: Num; actual_labour_hours_line?: Num },
  plannedPct: Num,
  actualPct: Num,
): EarnedValue {
  const revisedRaw = num(line.revised_budget_cost);
  const revised = revisedRaw.isZero() ? num(line.original_total_cost) : revisedRaw;
  const actual = num(line.actual_cost_to_date);
  const committed = num(line.committed_cost);
  const manual = line.forecast_cost_to_complete;
  const ctc =
    manual !== null && manual !== undefined ? num(manual) : max0(cents(revised.minus(actual).minus(committed)));

  const pp = num(plannedPct);
  const ap = num(actualPct);
  const planned = pp.isZero() ? ZERO : cents(revised.times(pp).div(100));
  const earned = ap.isZero() ? ZERO : cents(revised.times(ap).div(100));

  const origHours = num(line.original_labour_hours);
  const usedHours = num(line.actual_labour_hours_line);
  const earnedHours = origHours.gt(0) && !ap.isZero() ? pct2(origHours.times(ap).div(100)) : ZERO;

  return {
    revisedBudgetValue: revised,
    plannedValue: planned,
    earnedValue: earned,
    actualCostToDate: actual,
    committedCost: committed,
    forecastCostToComplete: ctc,
    forecastFinalCost: cents(actual.plus(committed).plus(ctc)),
    costVariance: cents(earned.minus(actual)),
    scheduleVariance: cents(earned.minus(planned)),
    cpi: actual.gt(0) ? pct2(earned.div(actual)) : null,
    spi: planned.gt(0) ? pct2(earned.div(planned)) : null,
    labourHoursAllowed: origHours,
    labourHoursUsed: usedHours,
    labourHoursEarned: earnedHours,
    labourProductivityVariance: pct2(earnedHours.minus(usedHours)),
  };
}

export interface Activity {
  status?: string;
  planned_percent_complete?: Num;
  actual_percent_complete?: Num;
}

export interface EvSnapshot {
  snapshot_date?: string;
  commercial_budget_line_id?: string;
  planned_value?: Num;
  earned_value?: Num;
  actual_cost_to_date?: Num;
  labour_hours_allowed?: Num;
  labour_hours_used?: Num;
  labour_hours_earned?: Num;
}

export interface DelayEvent {
  status?: string;
  eot_potential?: boolean;
  preliminaries_cost_impact?: Num;
}

export function programmeSummary(activities: Activity[], snapshots: EvSnapshot[], delays: DelayEvent[]) {
  const count = (s: string) => activities.filter((a) => a.status === s).length;
  const live = activities.filter((a) => a.status !== "Cancelled");
  const avg = (f: (a: Activity) => Num) =>
    live.length ? live.reduce((t, a) => t.plus(num(f(a))), ZERO).div(live.length).toDecimalPlaces(1, D.ROUND_HALF_UP) : ZERO;

  let pv = ZERO, ev = ZERO, ac = ZERO, hAllowed = ZERO, hUsed = ZERO, hEarned = ZERO;
  const seen = new Set<string>();
  const latestFirst = [...snapshots].sort((a, b) => (b.snapshot_date ?? "").localeCompare(a.snapshot_date ?? ""));
  for (const s of latestFirst) {
    const id = s.commercial_budget_line_id ?? "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    pv = pv.plus(num(s.planned_value));
    ev = ev.plus(num(s.earned_value));
    ac = ac.plus(num(s.actual_cost_to_date));
    hAllowed = hAllowed.plus(num(s.labour_hours_allowed));
    hUsed = hUsed.plus(num(s.labour_hours_used));
    hEarned = hEarned.plus(num(s.labour_hours_earned));
  }

  const open = delays.filter((d) => d.status !== "Closed" && d.status !== "Cancelled");
  return {
    totalActivities: activities.length,
    notStarted: count("Not Started"),
    inProgress: count("In Progress"),
    complete: count("Complete"),
    delayed: count("Delayed"),
    avgPlannedPct: avg((a) => a.planned_percent_complete),
    avgActualPct: avg((a) => a.actual_percent_complete),
    totalPlannedValue: cents(pv),
    totalEarnedValue: cents(ev),
    totalActualCost: cents(ac),
    costVariance: cents(ev.minus(ac)),
    scheduleVariance: cents(ev.minus(pv)),
    cpi: ac.gt(0) ? pct2(ev.div(ac)) : null,
    spi: pv.gt(0) ? pct2(ev.div(pv)) : null,
    labourHoursAllowed: pct2(hAllowed),
    labourHoursUsed: pct2(hUsed),
    labourHoursEarned: pct2(hEarned),
    labourProductivityVariance: pct2(hEarned.minus(hUsed)),
    openDelayEvents: open.length,
    eotPotentialCount: open.filter((d) => d.eot_potential).length,
    preliminariesExposure: cents(open.reduce((t, d) => t.plus(num(d.preliminaries_cost_impact)), ZERO)),
  };
}
