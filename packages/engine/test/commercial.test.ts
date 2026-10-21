import { describe, expect, it } from "vitest";
import {
  buildPaymentSchedule,
  budgetLineSummary,
  calculateEstimate,
  currentContractValue,
  D,
  earnedValue,
  fullPotential,
  priceVariations,
  programmeSummary,
  projectSummary,
  summariseEstimate,
  type EstimateInput,
} from "../src/index.js";

const s = (d: { toString(): string } | null) => (d === null ? null : d.toString());

const base: EstimateInput = {
  zones: [
    {
      tasks: [
        {
          resources: [
            { category: "labour", qty: 100, rate: 80 },
            { category: "material", qty: 10, rate: 200, included_in_total: false },
          ],
        },
      ],
    },
  ],
  risk_allowance_percent: 5,
  overhead_percent: 10,
  profit_margin_percent: 15,
  gst_percent: 15,
};

describe("scenarios", () => {
  it("full potential switches excluded items back on", () => {
    const inc = calculateEstimate(base);
    const full = fullPotential(base);
    expect(s(inc.costBase)).toBe("8000");
    expect(s(inc.excludedCost)).toBe("2000");
    expect(s(full.costBase)).toBe("10000");
  });

  it("prices variations on inherited settings and summarises contract value", () => {
    const b = calculateEstimate(base);
    const v = priceVariations(
      [
        { status: "approved", include_in_contract_total: true, zones: [{ tasks: [{ resources: [{ category: "labour", qty: 10, rate: 100 }] }] }] },
        { status: "draft", zones: [{ tasks: [{ resources: [{ category: "labour", qty: 5, rate: 100 }] }] }] },
      ],
      base,
    );
    // 1000 cost + 5% risk 50 + 10% overhead 100 = 1150, / 0.85 = 1352.94
    expect(s(v[0]!.totals.sellExGst)).toBe("1352.94");
    const sum = summariseEstimate(b, v);
    expect(s(sum.contractVariationsTotal)).toBe("1352.94");
    expect(s(sum.currentContractValue)).toBe(s(b.sellExGst.plus("1352.94")));
    expect(sum.statusCounts.approved).toBe(1);
    expect(sum.statusCounts.draft).toBe(1);
  });

  it("current contract value adds approved variations and subtracts credits", () => {
    const r = currentContractValue(
      new D(1000),
      [
        { status: "approved", type: "variation", amount_ex_gst: 200 },
        { status: "approved", type: "credit", amount_ex_gst: 50 },
        { status: "draft", type: "variation", amount_ex_gst: 999 },
      ],
      0.15,
    );
    expect(s(r.currentContractValue)).toBe("1150");
    expect(s(r.currentContractValueIncGst)).toBe("1322.5");
  });
});

describe("commercial control", () => {
  it("computes budget line forecast and status", () => {
    const ok = budgetLineSummary({
      original_total_cost: 1000, approved_variation_cost_adjustment: 100, actual_cost_to_date: 600, committed_cost: 200,
    });
    expect(s(ok.revisedBudgetCost)).toBe("1100");
    expect(s(ok.forecastCostToComplete)).toBe("300");
    expect(s(ok.forecastFinalCost)).toBe("1100");
    expect(ok.status).toBe("Tracking OK");

    const over = budgetLineSummary({ original_total_cost: 1100, actual_cost_to_date: 900, committed_cost: 300 });
    expect(s(over.forecastCostToComplete)).toBe("0");
    expect(over.status).toBe("Over Budget");

    const watch = budgetLineSummary({ original_total_cost: 1000, actual_cost_to_date: 500, committed_cost: 0, forecast_cost_to_complete: 530 });
    expect(watch.status).toBe("Watch");
  });

  it("rolls up a project summary with margins and unallocated costs", () => {
    const r = projectSummary(
      [
        { id: "a", original_total_cost: 6000, actual_cost_to_date: 3000, committed_cost: 1000, original_labour_hours: 100 },
        { id: "b", original_total_cost: 4000, actual_cost_to_date: 1000 },
      ],
      [{ amount_ex_gst: 250, labour_hours: 40 }, { amount_ex_gst: 100, commercial_budget_line_id: "a", labour_hours: 10 }],
      [{ committed_amount_ex_gst: 75 }],
      { original_contract_value_ex_gst: 12500 },
      500,
    );
    expect(s(r.currentContractValue)).toBe("13000");
    expect(s(r.originalProfit)).toBe("2500");
    expect(s(r.originalMarginPct)).toBe("20");
    expect(s(r.revisedBudget)).toBe("10000");
    expect(s(r.unallocatedCostTotal)).toBe("250");
    expect(s(r.unallocatedCommitmentTotal)).toBe("75");
    expect(s(r.labourBurnPct)).toBe("50");
  });

  it("computes earned value and programme summary", () => {
    const ev = earnedValue({ original_total_cost: 1000, actual_cost_to_date: 400, original_labour_hours: 100, actual_labour_hours_line: 30 }, 50, 40);
    expect(s(ev.plannedValue)).toBe("500");
    expect(s(ev.earnedValue)).toBe("400");
    expect(s(ev.cpi)).toBe("1");
    expect(s(ev.spi)).toBe("0.8");
    expect(s(ev.labourHoursEarned)).toBe("40");

    const p = programmeSummary(
      [{ status: "Complete", planned_percent_complete: 100, actual_percent_complete: 100 }, { status: "In Progress", planned_percent_complete: 50, actual_percent_complete: 25 }],
      [
        { snapshot_date: "2026-01-01", commercial_budget_line_id: "a", earned_value: 1, planned_value: 1 },
        { snapshot_date: "2026-02-01", commercial_budget_line_id: "a", earned_value: 400, planned_value: 500, actual_cost_to_date: 400 },
      ],
      [{ status: "Open", eot_potential: true, preliminaries_cost_impact: 300 }, { status: "Closed", preliminaries_cost_impact: 999 }],
    );
    expect(s(p.avgActualPct)).toBe("62.5");
    expect(s(p.totalEarnedValue)).toBe("400");
    expect(s(p.spi)).toBe("0.8");
    expect(p.eotPotentialCount).toBe(1);
    expect(s(p.preliminariesExposure)).toBe("300");
  });
});

describe("payment schedule", () => {
  const zones = [
    { id: "zA", name: "A", tasks: [{ id: "t1", name: "T1", resources: [{ qty: 60, rate: 100 }] }] },
    { id: "zB", name: "B", tasks: [{ id: "t2", name: "T2", resources: [{ qty: 40, rate: 100 }] }] },
  ];

  it("splits by direct cost, scales stages for the deposit, and reconciles", () => {
    const r = buildPaymentSchedule({
      zones,
      sellExGst: new D(15000),
      totalIncGst: new D(17250),
      gstRate: new D("0.15"),
      deposit: { type: "percent", input_value: 10 },
      retention: { enabled: true, pct: 5, cap_pct: 10, basis: "stages_only" },
      stages: [{ id: "s1", stage_order: 1, source: "zone_linked", linked_zone_ids: ["zA"] }],
      variations: [],
    });
    expect(s(r.zones[0]!.paymentExGst)).toBe("9000");
    expect(s(r.zones[1]!.paymentExGst)).toBe("6000");
    expect(s(r.deposit.depositExGst)).toBe("1500");
    expect(s(r.stages[0]!.valueExGst)).toBe("8100");
    expect(s(r.stages[0]!.retentionExGst)).toBe("405");
    expect(s(r.finalPayment.valueExGst)).toBe("5400");
    expect(s(r.retention.heldExGst)).toBe("405");
    expect(r.retention.capExceeded).toBe(false);
    expect(r.reconciliation.zoneExGstMatch && r.reconciliation.zoneIncGstMatch).toBe(true);
  });

  it("refuses a deposit larger than the contract and a zero-cost schedule", () => {
    const common = { gstRate: new D("0.15"), retention: {}, stages: [], variations: [], sellExGst: new D(100), totalIncGst: new D(115) };
    expect(() => buildPaymentSchedule({ ...common, zones, deposit: { type: "percent", input_value: 150 } })).toThrow(/Deposit exceeds/);
    expect(() => buildPaymentSchedule({ ...common, zones: [], deposit: { type: "none" } })).toThrow(/direct cost/);
  });
});
