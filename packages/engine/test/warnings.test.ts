import { describe, expect, it } from "vitest";
import { bySeverity, generateClaimWarnings, generateProgrammeWarnings, generateVariationWarnings, generateWarnings, projectSummary, type BudgetLine } from "../src/index.js";

const line = (o: Record<string, unknown>): BudgetLine => ({ zone_name: "Z", task_name: "T", resource_name: "R", resource_type: "Labour", original_total_cost: 1000, actual_cost_to_date: 0, committed_cost: 0, ...o });
const sum = (lines: BudgetLine[], o: { contract?: number; budget?: number; unallocated?: number; approved?: number } = {}) =>
  projectSummary(lines, o.unallocated ? [{ amount_ex_gst: o.unallocated, commercial_budget_line_id: null }] : [], [], { original_contract_value_ex_gst: o.contract ?? 100000, original_budget_cost: o.budget ?? 80000 }, o.approved ?? 0);
const types = (w: { warning_type: string }[]) => w.map((x) => x.warning_type);

describe("cost, commitment, labour, preliminary, risk and margin warnings", () => {
  it("a line spent past its budget is a cost overrun, High when it is more than 10% over and Medium otherwise", () => {
    const w = generateWarnings(sum([line({ id: "a", actual_cost_to_date: 900, committed_cost: 300 }), line({ id: "b", actual_cost_to_date: 1050 })]));
    expect(w.map((x) => [x.warning_type, x.severity, x.commercial_budget_line_id])).toEqual([["Cost Overrun", "High", "a"], ["Cost Overrun", "Medium", "b"]]);
    expect(w[0]).toMatchObject({ title: "Cost overrun: Z / T / R", description: "Actual + committed ($1,200.00) exceeds revised budget ($1,000.00) by $200.00." });
  });

  it("a line bought out exactly at its budget is not a warning (QSi's 'commitment exceeds remaining budget' rule, which flagged it, is left out)", () => {
    expect(generateWarnings(sum([line({ id: "c", actual_cost_to_date: 400, committed_cost: 600 })]))).toEqual([]); // 1,000 spent and ordered on a budget of 1,000
    expect(generateWarnings(sum([line({ id: "c2", actual_cost_to_date: 0, committed_cost: 600 })]))).toEqual([]);
    expect(types(generateWarnings(sum([line({ id: "c3", actual_cost_to_date: 400, committed_cost: 700 })])))).toEqual(["Cost Overrun"]); // ordered past the budget: the overrun says so
  });

  it("labour hours past those allowed", () => {
    const w = generateWarnings(sum([line({ id: "e", original_labour_hours: 10, actual_labour_hours_line: 12 })]));
    expect(w.map((x) => [x.warning_type, x.description])).toEqual([["Labour Overrun", "Actual hours (12.0) exceed allowed (10.0)."]]);
    expect(generateWarnings(sum([line({ id: "e2", original_labour_hours: 10, actual_labour_hours_line: 10 })]))).toEqual([]);
  });

  it("preliminaries over budget are flagged on top of the overrun, and only for preliminaries", () => {
    const w = generateWarnings(sum([line({ id: "p", resource_type: "Preliminaries", actual_cost_to_date: 1100 })]));
    expect(types(w)).toEqual(["Cost Overrun", "Preliminaries Overrun"]);
    expect(w[1]!.severity).toBe("High");
    expect(types(generateWarnings(sum([line({ id: "q", resource_type: "Plant", actual_cost_to_date: 1100 })])))).toEqual(["Cost Overrun"]);
  });

  it("a risk allowance is a warning from 80% consumed, High at 100%", () => {
    const risk = (spent: number) => generateWarnings(sum([line({ id: "r", resource_type: "Risk", actual_cost_to_date: spent })]));
    expect(risk(790)).toEqual([]);
    expect(risk(850).map((x) => [x.warning_type, x.severity, x.title])).toEqual([["Risk Allowance Consumed", "Medium", "Risk allowance 85% consumed: Z / T / R"]]);
    expect(risk(1000).map((x) => x.severity)).toEqual(["High"]);
  });

  it("the margin dropping more than two points is a warning, Critical past five", () => {
    // contract 100,000 on a budget of 80,000 is a 20% margin
    const at = (finalCost: number) => generateWarnings(sum([line({ id: "m", original_total_cost: 80000, actual_cost_to_date: finalCost })])).filter((x) => x.warning_type === "Margin Drop");
    expect(at(80000)).toEqual([]);
    expect(at(82000)).toEqual([]); // 18%: exactly two points is not more than two
    const high = at(83000);
    expect(high.map((x) => [x.severity, x.title])).toEqual([["High", "Forecast margin dropped to 17.0%"]]);
    expect(high[0]!.description).toBe("Original margin was 20.0%, forecast is now 17.0% (drift: -3.0pp).");
    expect(at(90000).map((x) => x.severity)).toEqual(["Critical"]);
  });

  it("costs booked to no budget line are always High", () => {
    const w = generateWarnings(sum([line({ id: "u" })], { unallocated: 500 }));
    expect(w[0]).toMatchObject({ warning_type: "Unallocated Cost", severity: "High", description: "$500.00 in costs not allocated to any budget line." });
  });

  it("names a line the way the caller says, and types it the way the caller says", () => {
    const l = { id: "EW01", description: "Bulk earthworks", original_total_cost: 1000, actual_cost_to_date: 1100 } as BudgetLine;
    const w = generateWarnings(sum([l]), { label: (x) => `${x.id} ${x.description}`, resourceType: () => "Preliminaries" });
    expect(w.map((x) => x.title)).toEqual(["Cost overrun: EW01 Bulk earthworks", "Preliminaries overrun: EW01 Bulk earthworks"]);
  });
});

describe("variation warnings", () => {
  const today = "2026-11-10";
  const v = (o: Record<string, unknown>) => ({ id: "v1", variation_number: 3, title: "Extra kerb", status: "Draft", total_sell_ex_gst: 5000, ...o });
  it("a notice required and not issued, and one that may be late", () => {
    const w = generateVariationWarnings([v({ status: "Notice Required", date_notice_required_by: "2026-11-01" })], { variation_notice_required: true }, today);
    expect(w.map((x) => [x.warning_type, x.severity, x.title])).toEqual([["Variation Notice Not Issued", "High", "VO-003: Notice required but not yet issued"], ["Variation Notice Late", "Critical", "VO-003: Notice may be late"]]);
    expect(w[1]!.description).toBe("Notice was due by 2026-11-01 — today is 2026-11-10.");
    expect(generateVariationWarnings([v({ status: "Notice Required", date_notice_required_by: "2026-12-01" })], {}, today)).toEqual([]);
  });
  it("work proceeding without approval, a response that is overdue, a dispute, an approved variation not yet claimed", () => {
    const w = (o: Record<string, unknown>, p = {}) => generateVariationWarnings([v(o)], p, today).map((x) => [x.warning_type, x.severity]);
    expect(w({ status: "Proceeding At Risk" })).toEqual([["Work Proceeding At Risk", "High"]]);
    expect(w({ status: "Submitted", response_due_date: "2026-11-09" })).toEqual([["Variation Response Overdue", "Medium"]]);
    expect(w({ status: "Submitted", response_due_date: "2026-11-10" })).toEqual([]); // due today is not overdue
    expect(w({ status: "Disputed", dispute_reason: "Scope" })).toEqual([["Variation Disputed", "High"]]);
    expect(w({ status: "Approved", claim_status: "Not Ready", approved_sell_ex_gst: 4000 })).toEqual([["Approved VO Not Claimed", "Medium"]]);
  });
  it("EOT only when the contract needs the notice, and no pricing once it has moved past draft", () => {
    expect(generateVariationWarnings([v({ eot_required: true, eot_status: "Potential", time_impact_days: 3 })], { eot_notice_required: true }, today).map((x) => x.warning_type)).toEqual(["EOT Notice Required"]);
    expect(generateVariationWarnings([v({ eot_required: true, eot_status: "Potential" })], {}, today)).toEqual([]);
    expect(generateVariationWarnings([v({ status: "Submitted", total_sell_ex_gst: 0 })], {}, today).map((x) => x.warning_type)).toEqual(["Variation No Pricing"]);
    expect(generateVariationWarnings([v({ status: "Draft", total_sell_ex_gst: 0 })], {}, today)).toEqual([]);
  });
});

describe("claim warnings", () => {
  const today = "2026-11-10";
  const c = (o: Record<string, unknown>) => ({ claim_number: 2, status: "Issued", current_claim_ex_gst: 20000, ...o });
  it("a schedule or a payment past its due date, the payment as Critical", () => {
    const w = generateClaimWarnings([c({ payment_schedule_due_date: "2026-11-05", payment_due_date: "2026-11-09" })], [], {}, today);
    expect(w.map((x) => [x.warning_type, x.severity, x.title])).toEqual([["Payment Schedule Overdue", "High", "CLAIM-002: Payment schedule overdue"], ["Payment Overdue", "Critical", "CLAIM-002: Payment overdue"]]);
    expect(generateClaimWarnings([c({ status: "Paid", payment_due_date: "2026-11-01" })], [], {}, today)).toEqual([]);
  });
  it("under-certified, disputed and part paid", () => {
    const w = generateClaimWarnings([c({ status: "Certified", certified_amount_ex_gst: 18500 }), c({ status: "Issued", disputed_amount_ex_gst: 1500, deduction_reasons: "Defects" }), c({ status: "Part Paid", paid_amount_inc_gst: 10000, amount_due_inc_gst: 23000 })], [], {}, today);
    expect(w.map((x) => [x.warning_type, x.severity])).toEqual([["Under-certified Claim", "Medium"], ["Disputed Claim Amount", "High"], ["Part Paid Claim", "Medium"]]);
    expect(w[0]!.title).toBe("CLAIM-002: Under-certified by $1,500.00");
    expect(w[2]!.description).toBe("Paid $10,000.00 of $23,000.00 due.");
  });
  it("approved variations not yet claimed, the retention cap, and a missing CCA notice", () => {
    const vs = [{ variation_number: 1, status: "Approved", claim_status: "Not Ready", approved_sell_ex_gst: 3000 }, { variation_number: 2, status: "Approved", claim_status: "Ready To Claim", approved_sell_ex_gst: 800 }, { variation_number: 3, status: "Approved", claim_status: "Claimed", approved_sell_ex_gst: 100 }];
    const w = generateClaimWarnings([c({ cca_claim_statement_enabled: true, retention_cap_reached: true })], vs, { retentions_enabled: true, retention_cap_amount: 50000 }, today);
    expect(w.map((x) => [x.warning_type, x.severity])).toEqual([["CCA Notice Missing", "Medium"], ["Approved VO Not Claimed", "Low"], ["Approved VO Not Claimed", "Medium"], ["Retention Cap Reached", "Low"]]);
    expect(w[3]!.title).toBe("Retention cap of $50,000.00 has been reached");
  });
});

describe("programme warnings", () => {
  const today = "2026-11-10";
  it("an activity past its planned finish and not complete", () => {
    const w = generateProgrammeWarnings([
      { activity_code: "A1", activity_name: "Strip topsoil", planned_finish: "2026-11-05", status: "In Progress" }, { activity_code: "A2", activity_name: "Done", planned_finish: "2026-11-01", status: "Complete" },
      { activity_name: "No code", planned_finish: "2026-11-09", status: "Not Started" }, { activity_name: "Future", planned_finish: "2026-12-01", status: "Not Started" },
    ], [], [], today);
    expect(w.map((x) => x.title)).toEqual(["Activity delayed: A1: Strip topsoil", "Activity delayed: No code"]);
  });
  it("cost ahead of progress and schedule behind, from the latest snapshot of each line only", () => {
    const w = generateProgrammeWarnings([], [
      { snapshot_date: "2026-10-01", commercial_budget_line_id: "L1", earned_value: 100, actual_cost_to_date: 50, planned_value: 100 }, // earlier: ignored
      { snapshot_date: "2026-11-01", commercial_budget_line_id: "L1", earned_value: 800, actual_cost_to_date: 1000, planned_value: 1000, cpi: 0.8, spi: 0.8 },
    ], [], today);
    expect(w.map((x) => [x.warning_type, x.title])).toEqual([["Cost Ahead Of Progress", "Cost ahead of progress (CPI: 0.8)"], ["Schedule Behind", "Schedule behind (SPI: 0.8)"]]);
    expect(generateProgrammeWarnings([], [{ snapshot_date: "2026-11-01", commercial_budget_line_id: "L2", earned_value: 950, actual_cost_to_date: 900, planned_value: 1000 }], [], today)).toEqual([]);
  });
  it("delay events: an EOT with no notice, a delay with no variation, preliminaries exposed; closed ones are left alone", () => {
    const d = (o: Record<string, unknown>) => ({ delay_event_number: 4, title: "Wet ground", status: "Open", delay_days: 6, ...o });
    const w = generateProgrammeWarnings([], [], [d({ eot_potential: true, delay_type: "Client Delay", preliminaries_cost_impact: 2500 }), d({ status: "Closed", eot_potential: true })], today);
    expect(w.map((x) => [x.warning_type, x.severity])).toEqual([["EOT Notice Required", "High"], ["Delay Not Linked To Variation", "Medium"], ["Preliminaries Exposure", "Medium"]]);
    expect(w[2]!.title).toBe("DELAY-004: Preliminaries exposure $2,500.00");
  });
});

describe("ordering", () => {
  it("puts the most serious first and keeps the order found within a severity", () => {
    const w = (severity: "Low" | "Medium" | "High" | "Critical", t: string) => ({ warning_type: t, severity, title: t, description: "", suggested_action: "" });
    expect(bySeverity([w("Low", "a"), w("High", "b"), w("Critical", "c"), w("High", "d"), w("Medium", "e")]).map((x) => x.title)).toEqual(["c", "b", "d", "e", "a"]);
  });
});
