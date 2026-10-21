/**
 * NZ labour true-cost build-up (Management Reserve & Labour True-Cost Policy Rev1, sections 6-12).
 *
 * A library labour rate is the true direct employer cost of making a person available for productive work, per
 * productive hour:
 *
 *   weekly pay (paid hours x gross hourly rate)
 *   + employer KiwiSaver                 % of weekly pay
 *   + holiday, statutory and sick leave  % of weekly pay (non-working weeks / worked weeks)
 *   + insurance and ACC levies           % of the running total
 *   + redundancy provision (optional)    % of the running total
 *   + weekly allowances (tools, clothing, phone ...) $ per week
 *   + supervision (leading hand) loading % of the running total
 *   = weekly true cost -> divided by PRODUCTIVE hours per week = $ per productive hour
 *
 * PAYE is not an employer cost and is never added. Corporate overhead, profit, fleet and preliminaries are not labour.
 * Status follows the policy: GREEN needs a company actual AND an independent check; a normalised market or comparable
 * rate is AMBER; a raw wage, or an unknown basis, is RED.
 */
import { cents, D, type Dec } from "@blackline/engine";

export const EVIDENCE = ["company actual", "company historical", "comparable contractor", "market normalised", "raw wage"] as const;
const WEEKS_PER_YEAR = new D(365).div(7);
const NUMERIC = [
  "hourly_rate", "paid_hours_week", "productive_hours_week", "kiwisaver_pct", "annual_leave_days", "stat_days", "sick_days",
  "other_paid_days", "days_per_week", "levy_pct", "redundancy_pct", "weekly_allowance", "supervision_pct",
] as const;
const TEXT = ["role", "jurisdiction", "employment_basis", "source_date", "evidence", "source_note", "reviewer"] as const;
const PCT = ["kiwisaver_pct", "levy_pct", "redundancy_pct", "supervision_pct"];

export class LabourError extends Error {}

export type LabourInputs = Record<(typeof TEXT)[number] | (typeof NUMERIC)[number], string> & { independent_check: boolean };

const label = (f: string) => {
  const s = f.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/** Validated inputs (percentages as fractions: 0.03 = 3%). */
export function cleanLabour(raw: Record<string, unknown>): LabourInputs {
  const out: Record<string, string | boolean> = {};
  for (const k of TEXT) {
    const v = String(raw[k] ?? "").trim();
    if (v.length > 300) throw new LabourError(`${label(k)} is too long.`);
    out[k] = v;
  }
  if (!out.role) throw new LabourError("Say which role this rate is for.");
  if (!(EVIDENCE as readonly string[]).includes(out.evidence as string)) throw new LabourError(`Evidence must be one of: ${EVIDENCE.join(", ")}.`);
  for (const k of NUMERIC) {
    let v: Dec;
    const r = raw[k];
    try {
      v = new D(String(r === null || r === undefined || r === "" ? "0" : r).replace(/,/g, ""));
      if (!v.isFinite()) throw new Error();
    } catch {
      throw new LabourError(`${label(k)} must be a number.`);
    }
    if (v.lt(0)) throw new LabourError(`${label(k)} can't be negative.`);
    if (PCT.includes(k) && v.gt(1)) throw new LabourError(`${label(k)} is a fraction (0.03 means 3%).`);
    out[k] = v.toString();
  }
  out.independent_check = !!raw.independent_check;
  for (const k of ["hourly_rate", "paid_hours_week", "productive_hours_week", "days_per_week"])
    if (new D(out[k] as string).lte(0)) throw new LabourError(`${label(k)} must be more than zero.`);
  if (new D(out.productive_hours_week as string).gt(new D(out.paid_hours_week as string))) throw new LabourError("Productive hours can't exceed paid hours.");
  return out as LabourInputs;
}

/** Non-working weeks, worked weeks, and the loading (non-working / worked). */
export function leaveLoading(i: LabourInputs) {
  const dpw = new D(i.days_per_week);
  const nonwork = new D(i.annual_leave_days).plus(i.stat_days).plus(i.sick_days).plus(i.other_paid_days).div(dpw);
  const worked = WEEKS_PER_YEAR.minus(nonwork);
  if (worked.lte(0)) throw new LabourError("The leave days leave no working weeks in the year.");
  return { nonwork, worked, pct: nonwork.div(worked) };
}

export type LabourStatus = "GREEN" | "AMBER" | "RED";

export function labourStatus(i: LabourInputs): { status: LabourStatus; statusNote: string } {
  if (i.evidence === "raw wage") return { status: "RED", statusNote: "A raw wage is not a true-cost rate. Use the build-up with real on-costs and a source." };
  if (!i.employment_basis || !i.source_date) return { status: "RED", statusNote: "The employment basis and the source date must be recorded." };
  const company = i.evidence === "company actual" || i.evidence === "company historical";
  if (company && i.independent_check) return { status: "GREEN", statusNote: "Company actual with an independent check." };
  if (company) return { status: "AMBER", statusNote: "Company actual, but the independent check isn't recorded yet." };
  return { status: "AMBER", statusNote: "Normalised from market or comparable evidence: AMBER until company actuals are available." };
}

export interface LabourStep {
  label: string;
  basis: string;
  amount: Dec;
  running: Dec;
}

export interface LabourResult {
  inputs: LabourInputs;
  steps: LabourStep[];
  weeklyCost: Dec;
  rate: Dec;
  rateRounded: Dec;
  perPaidHour: Dec;
  leavePct: Dec;
  productivity: Dec;
  status: LabourStatus;
  statusNote: string;
}

const money = (x: Dec) => x.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const pct2 = (x: Dec) => x.times(100).toFixed(2);

export function computeLabourRate(raw: Record<string, unknown>): LabourResult {
  const i = cleanLabour(raw);
  const pay = new D(i.paid_hours_week).times(i.hourly_rate);
  const leave = leaveLoading(i);
  const steps: LabourStep[] = [];
  let run = pay;

  const step = (lbl: string, basis: string, amount: Dec) => {
    run = run.plus(amount);
    steps.push({ label: lbl, basis, amount, running: run });
  };

  steps.push({ label: "Weekly pay", basis: `${i.paid_hours_week} paid hours x $${money(new D(i.hourly_rate))}`, amount: pay, running: pay });
  step("Employer KiwiSaver", `${pct2(new D(i.kiwisaver_pct))}% of weekly pay`, pay.times(i.kiwisaver_pct));
  step("Holiday, statutory and sick leave", `${pct2(leave.pct)}% of weekly pay (${leave.nonwork.toFixed(2)} non-working weeks / ${leave.worked.toFixed(2)} worked weeks)`, pay.times(leave.pct));
  step("Insurance and ACC levies", `${pct2(new D(i.levy_pct))}% of the total so far`, run.times(i.levy_pct));
  step("Redundancy provision", `${pct2(new D(i.redundancy_pct))}% of the total so far`, run.times(i.redundancy_pct));
  step("Weekly allowances (tools, clothing)", "per week", new D(i.weekly_allowance));
  step("Supervision (leading hand) loading", `${pct2(new D(i.supervision_pct))}% of the total so far`, run.times(i.supervision_pct));

  const weekly = run;
  const rate = weekly.div(i.productive_hours_week);
  return {
    inputs: i, steps, weeklyCost: weekly, rate, rateRounded: cents(rate), perPaidHour: weekly.div(i.paid_hours_week),
    leavePct: leave.pct, productivity: new D(i.productive_hours_week).div(i.paid_hours_week), ...labourStatus(i),
  };
}

/** The library description for a built rate, worded as the policy requires (external benchmarks are marked as such). */
export function labourDescription(i: LabourInputs): string {
  const base = `${i.role} - true direct employment cost per productive hour`;
  const external = i.evidence === "market normalised" || i.evidence === "comparable contractor";
  return (external ? `${base} (external market normalised benchmark: excludes corporate overhead, profit and costs priced elsewhere)` : `${base} (excludes overhead and profit)`).slice(0, 200);
}

/** The library source line for a built rate: what it rests on and how strongly. */
export function labourLibrarySource(i: LabourInputs, status: LabourStatus): string {
  return `Labour build-up: ${i.evidence}, ${i.jurisdiction || "NZ"}, ${i.employment_basis}, source dated ${i.source_date}, ${status}${i.reviewer ? `, reviewed by ${i.reviewer}` : ""}`.slice(0, 300);
}