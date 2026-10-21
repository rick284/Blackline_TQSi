/**
 * Commercial warnings, ported from QSi services/commercial_control_engine.py (generate_warnings, generate_variation_warnings,
 * generate_claim_warnings, generate_programme_warnings). Each takes the same shapes QSi does (snake_case keys) and returns a list of warnings that is
 * not persisted: the caller decides what to do with it. The one change from QSi is that "today" is an argument, not read from the clock, so the same
 * inputs give the same warnings on every computer. Amounts are decimals, so a threshold is never decided by a float.
 */
import { cents, D, type Dec } from "./money.js";
import type { ProjectSummary } from "./commercial.js";
import type { Num } from "./types.js";

export type Severity = "Low" | "Medium" | "High" | "Critical";
export interface Warning {
  warning_type: string;
  severity: Severity;
  title: string;
  description: string;
  suggested_action: string;
  commercial_budget_line_id?: string;
  variation_id?: string;
}

const dec = (x: unknown): Dec => { try { return new D(x === null || x === undefined || x === "" ? 0 : String(x)); } catch { return new D(0); } };
const money = (x: Dec) => `$${cents(x).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
const pad3 = (n: unknown) => String(Number(n ?? 0)).padStart(3, "0");
const s = (x: unknown) => (x === null || x === undefined ? "" : String(x));
const date = (x: unknown) => s(x).slice(0, 10);

// ---- cost, commitments, labour, preliminaries, risk, margin ---------------------------------------------------------------------------------
export interface LineLabel { zone_name?: string; task_name?: string; resource_name?: string; resource_type?: string; description?: string; id?: string }

export interface WarningOptions {
  /** How a budget line is named in a warning. QSi names it zone / task / resource; a caller with other names says how. */
  label?: (line: Record<string, unknown>) => string;
  /** QSi treats resource types "Preliminaries" and "Risk" specially; a caller maps its own lines onto them. */
  resourceType?: (line: Record<string, unknown>) => string;
}

const qsiLabel = (l: Record<string, unknown>) => `${s(l.zone_name)} / ${s(l.task_name)} / ${s(l.resource_name)}`;

export function generateWarnings(summary: ProjectSummary, opts: WarningOptions = {}): Warning[] {
  const out: Warning[] = [];

  // 1. costs not allocated to any budget line
  if (summary.unallocatedCostTotal.gt(0)) {
    out.push({
      warning_type: "Unallocated Cost", severity: "High", title: "Unallocated costs detected",
      description: `${money(summary.unallocatedCostTotal)} in costs not allocated to any budget line.`,
      suggested_action: "Allocate costs to budget lines or investigate source.",
    });
  }

  // 2. per line
  for (const line of summary.lines) {
    const l = line as Record<string, unknown>;
    const sm = line.summary;
    const id = s(l.id), name = (opts.label ?? qsiLabel)(l), rtype = (opts.resourceType ?? ((x) => s(x.resource_type)))(l);
    const actual = dec(l.actual_cost_to_date), committed = dec(l.committed_cost), revised = sm.revisedBudgetCost;
    const spent = actual.plus(committed);
    const base = { commercial_budget_line_id: id };

    if (spent.gt(revised) && revised.gt(0)) {
      const overrun = cents(spent.minus(revised));
      out.push({
        warning_type: "Cost Overrun", severity: overrun.gt(revised.times("0.1")) ? "High" : "Medium", title: `Cost overrun: ${name}`,
        description: `Actual + committed (${money(spent)}) exceeds revised budget (${money(revised)}) by ${money(overrun)}.`,
        suggested_action: "Review costs, seek variation recovery or adjust forecast.", ...base,
      });
    }
    // QSi also warns "Commitment Exceeds Remaining Budget" when committed > budget_remaining, but its budget_remaining is what is left AFTER the
    // commitments, so that rule fires on any line bought out at its budget (an order of 10,000 on a line of 10,000, with 4,000 invoiced, has 0
    // "remaining"). Real over-commitment is the overrun above, so the rule is left out rather than ported with that false alarm.

    const origHours = dec(l.original_labour_hours), usedHours = dec(l.actual_labour_hours_line);
    if (origHours.gt(0) && usedHours.gt(origHours)) {
      out.push({
        warning_type: "Labour Overrun", severity: "Medium", title: `Labour overrun: ${name}`,
        description: `Actual hours (${usedHours.toFixed(1)}) exceed allowed (${origHours.toFixed(1)}).`,
        suggested_action: "Review productivity and adjust forecast.", ...base,
      });
    }

    if (rtype === "Preliminaries" && spent.gt(revised) && revised.gt(0)) {
      out.push({
        warning_type: "Preliminaries Overrun", severity: "High", title: `Preliminaries overrun: ${name}`,
        description: `Prelim actual + committed (${money(spent)}) exceeds budget (${money(revised)}).`,
        suggested_action: "Review prelim exposure and programme impact.", ...base,
      });
    }

    if (rtype === "Risk" && revised.gt(0)) {
      const consumed = spent.div(revised).times(100);
      if (consumed.gte(80)) {
        out.push({
          warning_type: "Risk Allowance Consumed", severity: consumed.gte(100) ? "High" : "Medium", title: `Risk allowance ${consumed.toFixed(0)}% consumed: ${name}`,
          description: `Risk budget ${money(revised)} is ${consumed.toFixed(0)}% consumed (${money(spent)} spent/committed).`,
          suggested_action: "Review risk register and remaining exposure.", ...base,
        });
      }
    }
  }

  // 3. margin drop: more than two points below where it started
  const orig = summary.originalMarginPct, fc = summary.forecastFinalMarginPct;
  if (orig.gt(0) && orig.minus(fc).gt(2)) {
    out.push({
      warning_type: "Margin Drop", severity: orig.minus(fc).gt(5) ? "Critical" : "High", title: `Forecast margin dropped to ${fc.toFixed(1)}%`,
      description: `Original margin was ${orig.toFixed(1)}%, forecast is now ${fc.toFixed(1)}% (drift: ${summary.marginDrift.toFixed(1)}pp).`,
      suggested_action: "Review cost drivers, seek variation recovery, adjust forecasts.",
    });
  }
  return out;
}

// ---- variations -----------------------------------------------------------------------------------------------------------------------------
export interface VariationIn {
  id?: string; variation_number?: number; title?: string; status?: string;
  date_notice_required_by?: string; response_due_date?: string; total_sell_ex_gst?: Num; approved_sell_ex_gst?: Num;
  claim_status?: string; dispute_reason?: string; eot_required?: boolean; eot_status?: string; time_impact_days?: Num;
}
export interface WarningProfile {
  variation_notice_required?: boolean; eot_notice_required?: boolean; retentions_enabled?: boolean; retention_cap_amount?: Num;
}

export function generateVariationWarnings(variations: VariationIn[], profile: WarningProfile, today: string): Warning[] {
  const out: Warning[] = [];
  for (const v of variations) {
    const vo = `VO-${pad3(v.variation_number)}`, status = s(v.status), base = { variation_id: v.id };
    const noticeBy = date(v.date_notice_required_by), respDue = date(v.response_due_date);

    if (status === "Notice Required" && profile.variation_notice_required) {
      out.push({ warning_type: "Variation Notice Not Issued", severity: "High", title: `${vo}: Notice required but not yet issued`, description: `${s(v.title)} — notice due by ${noticeBy || "?"}`,
        suggested_action: "Issue formal notice to the principal/engineer immediately.", ...base });
    }
    if (status === "Notice Required" && noticeBy && noticeBy < today) {
      out.push({ warning_type: "Variation Notice Late", severity: "Critical", title: `${vo}: Notice may be late`, description: `Notice was due by ${noticeBy} — today is ${today}.`,
        suggested_action: "Issue notice immediately. Late notice may jeopardise claim entitlement.", ...base });
    }
    if (status === "Proceeding At Risk") {
      out.push({ warning_type: "Work Proceeding At Risk", severity: "High", title: `${vo}: Work proceeding without approval`, description: `${s(v.title)} — value: ${money(dec(v.total_sell_ex_gst))}`,
        suggested_action: "Seek written instruction or approval before continuing. Document all evidence.", ...base });
    }
    if (status === "Submitted" && respDue && respDue < today) {
      out.push({ warning_type: "Variation Response Overdue", severity: "Medium", title: `${vo}: Response overdue`, description: `Submitted variation response was due ${respDue}.`,
        suggested_action: "Follow up with principal/engineer. Document all follow-up.", ...base });
    }
    if (status === "Approved" && v.claim_status === "Not Ready") {
      out.push({ warning_type: "Approved VO Not Claimed", severity: "Medium", title: `${vo}: Approved but not marked ready to claim`, description: `Approved value: ${money(dec(v.approved_sell_ex_gst))}`,
        suggested_action: "Mark as ready to claim and include in next payment claim.", ...base });
    }
    if (status === "Disputed") {
      out.push({ warning_type: "Variation Disputed", severity: "High", title: `${vo}: Variation is disputed`, description: `Reason: ${s(v.dispute_reason) || "Not specified"}`,
        suggested_action: "Gather evidence, review contract clauses, seek resolution.", ...base });
    }
    if (v.eot_required && ["Not Required", "Potential", ""].includes(s(v.eot_status)) && profile.eot_notice_required) {
      out.push({ warning_type: "EOT Notice Required", severity: "Medium", title: `${vo}: EOT may be required but no notice issued`, description: `Time impact: ${s(v.time_impact_days) || 0} days`,
        suggested_action: "Issue EOT notice within contractual timeframes.", ...base });
    }
    if (!["Draft", "Notice Required", "Closed", "Rejected"].includes(status) && dec(v.total_sell_ex_gst).isZero()) {
      out.push({ warning_type: "Variation No Pricing", severity: "Medium", title: `${vo}: No pricing line items`, description: "Variation has been progressed without pricing.",
        suggested_action: "Add pricing line items before submission.", ...base });
    }
  }
  return out;
}

// ---- payment claims -------------------------------------------------------------------------------------------------------------------------
export interface ClaimIn {
  claim_number?: number; status?: string; payment_schedule_due_date?: string; payment_due_date?: string;
  current_claim_ex_gst?: Num; certified_amount_ex_gst?: Num; disputed_amount_ex_gst?: Num; deduction_reasons?: string;
  paid_amount_inc_gst?: Num; amount_due_inc_gst?: Num; cca_claim_statement_enabled?: boolean; prescribed_notice_attached?: boolean; retention_cap_reached?: boolean;
}

export function generateClaimWarnings(claims: ClaimIn[], approvedVariations: VariationIn[], profile: WarningProfile, today: string): Warning[] {
  const out: Warning[] = [];
  for (const c of claims) {
    const cn = `CLAIM-${pad3(c.claim_number)}`, status = s(c.status);
    const schedDue = date(c.payment_schedule_due_date), payDue = date(c.payment_due_date);

    if (status === "Issued" && schedDue && schedDue < today) {
      out.push({ warning_type: "Payment Schedule Overdue", severity: "High", title: `${cn}: Payment schedule overdue`, description: `Schedule was due ${schedDue}.`, suggested_action: "Follow up with principal. Consider CCA default provisions." });
    }
    if (["Issued", "Payment Schedule Received", "Certified"].includes(status) && payDue && payDue < today) {
      out.push({ warning_type: "Payment Overdue", severity: "Critical", title: `${cn}: Payment overdue`, description: `Payment was due ${payDue}.`,
        suggested_action: "Issue follow-up. Review CCA rights including suspension and charging provisions." });
    }
    const claimed = dec(c.current_claim_ex_gst), certified = dec(c.certified_amount_ex_gst);
    if (["Payment Schedule Received", "Certified"].includes(status) && certified.lt(claimed) && claimed.gt(0)) {
      const diff = cents(claimed.minus(certified));
      out.push({ warning_type: "Under-certified Claim", severity: "Medium", title: `${cn}: Under-certified by ${money(diff)}`, description: `Claimed ${money(claimed)}, certified ${money(certified)}.`,
        suggested_action: "Review deductions and consider adjudication if dispute is unresolved." });
    }
    const disputed = dec(c.disputed_amount_ex_gst);
    if (disputed.gt(0) && status !== "Closed") {
      out.push({ warning_type: "Disputed Claim Amount", severity: "High", title: `${cn}: ${money(disputed)} disputed`, description: s(c.deduction_reasons) || "No reason provided",
        suggested_action: "Gather evidence and seek resolution. Consider adjudication timeline." });
    }
    if (status === "Part Paid") {
      out.push({ warning_type: "Part Paid Claim", severity: "Medium", title: `${cn}: Only partially paid`, description: `Paid ${money(dec(c.paid_amount_inc_gst))} of ${money(dec(c.amount_due_inc_gst))} due.`,
        suggested_action: "Follow up on remaining payment." });
    }
    if (c.cca_claim_statement_enabled && !c.prescribed_notice_attached && status === "Issued") {
      out.push({ warning_type: "CCA Notice Missing", severity: "Medium", title: `${cn}: CCA prescribed notice not attached`,
        description: "CCA claim statement is enabled but prescribed notice is marked as not attached.", suggested_action: "Attach prescribed notice to maintain CCA compliance." });
    }
  }

  for (const v of approvedVariations) {
    if (["Not Ready", "Ready To Claim"].includes(s(v.claim_status)) && v.status === "Approved") {
      const sell = dec(v.approved_sell_ex_gst);
      if (sell.gt(0)) {
        out.push({ warning_type: "Approved VO Not Claimed", severity: v.claim_status === "Not Ready" ? "Low" : "Medium", title: `VO-${pad3(v.variation_number)}: Approved but not claimed (${money(sell)})`,
          description: `Claim status: ${s(v.claim_status) || "Not Ready"}`, suggested_action: "Include in next payment claim." });
      }
    }
  }

  if (profile.retentions_enabled && dec(profile.retention_cap_amount).gt(0)) {
    const cap = dec(profile.retention_cap_amount);
    if (claims.some((c) => c.retention_cap_reached)) {
      out.push({ warning_type: "Retention Cap Reached", severity: "Low", title: `Retention cap of ${money(cap)} has been reached`, description: "No further retention will be deducted from claims.",
        suggested_action: "Confirm with principal. Plan for retention release at practical completion." });
    }
  }
  return out;
}

// ---- programme ------------------------------------------------------------------------------------------------------------------------------
export interface ActivityIn { activity_code?: string; activity_name?: string; planned_finish?: string; status?: string }
export interface EvSnapshotIn { snapshot_date?: string; commercial_budget_line_id?: string; earned_value?: Num; actual_cost_to_date?: Num; planned_value?: Num; cpi?: Num | null; spi?: Num | null }
export interface DelayEventIn {
  status?: string; delay_event_number?: number; title?: string; delay_days?: Num; eot_potential?: boolean; eot_notice_issued?: boolean;
  delay_type?: string; linked_variation_id?: string; preliminaries_cost_impact?: Num;
}

export function generateProgrammeWarnings(activities: ActivityIn[], snapshots: EvSnapshotIn[], delays: DelayEventIn[], today: string): Warning[] {
  const out: Warning[] = [];
  for (const a of activities) {
    const code = s(a.activity_code), name = s(a.activity_name), label = code ? `${code}: ${name}` : name;
    const finish = date(a.planned_finish);
    if (finish && finish < today && !["Complete", "Cancelled"].includes(s(a.status))) {
      out.push({ warning_type: "Activity Delayed", severity: "Medium", title: `Activity delayed: ${label}`, description: `Planned finish was ${finish}.`, suggested_action: "Review delay cause and consider EOT/variation." });
    }
  }

  // from the latest snapshot of each budget line
  const seen = new Set<string>();
  for (const snap of [...snapshots].sort((a, b) => s(b.snapshot_date).localeCompare(s(a.snapshot_date)))) {
    const id = s(snap.commercial_budget_line_id);
    if (seen.has(id)) continue;
    seen.add(id);
    const ev = dec(snap.earned_value), ac = dec(snap.actual_cost_to_date), pv = dec(snap.planned_value);
    if (ac.gt(0) && ev.gt(0) && ac.gt(ev)) {
      out.push({ warning_type: "Cost Ahead Of Progress", severity: "Medium", title: `Cost ahead of progress (CPI: ${s(snap.cpi)})`, description: `Earned: ${money(ev)}, Actual cost: ${money(ac)}.`,
        suggested_action: "Review cost drivers. Actual spend exceeds earned value." });
    }
    if (pv.gt(0) && ev.lt(pv.times("0.9"))) {
      out.push({ warning_type: "Schedule Behind", severity: "Medium", title: `Schedule behind (SPI: ${s(snap.spi)})`, description: `Planned value: ${money(pv)}, Earned: ${money(ev)}.`,
        suggested_action: "Review programme and recovery plan." });
    }
  }

  for (const d of delays) {
    if (["Closed", "Cancelled"].includes(s(d.status))) continue;
    const dn = `DELAY-${pad3(d.delay_event_number)}`;
    if (d.eot_potential && !d.eot_notice_issued) {
      out.push({ warning_type: "EOT Notice Required", severity: "High", title: `${dn}: EOT potential but no notice issued`, description: `${s(d.title)} — ${s(d.delay_days) || 0} days`,
        suggested_action: "Issue EOT notice within contractual timeframes." });
    }
    if (["Client Delay", "Design Delay", "Latent Condition", "Variation Related Delay"].includes(s(d.delay_type)) && !d.linked_variation_id) {
      out.push({ warning_type: "Delay Not Linked To Variation", severity: "Medium", title: `${dn}: Delay not linked to variation`, description: `Type: ${s(d.delay_type)} — may require VO for cost recovery.`,
        suggested_action: "Create or link variation for cost recovery." });
    }
    if (dec(d.preliminaries_cost_impact).gt(0)) {
      out.push({ warning_type: "Preliminaries Exposure", severity: "Medium", title: `${dn}: Preliminaries exposure ${money(dec(d.preliminaries_cost_impact))}`, description: `${s(d.delay_days) || 0} days delay.`,
        suggested_action: "Include prelim exposure in variation or forecast." });
    }
  }
  return out;
}

const RANK: Record<Severity, number> = { Critical: 0, High: 1, Medium: 2, Low: 3 };
/** Most serious first, otherwise in the order they were found. */
export const bySeverity = (w: Warning[]): Warning[] => w.map((x, i) => ({ x, i })).sort((a, b) => RANK[a.x.severity] - RANK[b.x.severity] || a.i - b.i).map((r) => r.x);
