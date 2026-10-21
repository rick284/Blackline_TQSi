import { describe, expect, it } from "vitest";
import { cents } from "@blackline/engine";
import { computeTenderEstimate, type TenderInputs } from "../src/index.js";

const s = (x: { toString(): string } | null | undefined) => (x === null || x === undefined ? null : x.toString());

const inputs = (over: Partial<TenderInputs> = {}): TenderInputs => ({
  library: [{ code: "SUB", description: "Subcontract", unit: "ea", baseRate: 1 }],
  qs: [{ code: "EW01", section: "Earthworks", description: "Bulk earthworks", unit: "m3", quantity: 1000 }],
  rows: [{ qsCode: "EW01", mode: "Lump Sum / Quote", resourceType: "Subcontract", resourceCode: "SUB", manualQty: 1, jobRateOverride: 10000, verified: "Yes", uid: "r1" }],
  weatherLinks: { dailyUid: "", hoursPerDay: 8, weeklyUids: [] },
  tool: { exposedPool: 0, rainWetGroundCost: 0, criticalPathDelayWd: 0, additionalBilledWeeks: 0 },
  commercial: [
    { ref: "CA03", name: "Allowance", method: "%", include: "Yes", pct: "0.02", pcSum: 0 },
    { ref: "CA17", name: "Overhead", method: "Markup %", include: "Yes", pct: "0.10", pcSum: 0 },
    { ref: "CA18", name: "Profit", method: "Margin %", include: "Yes", pct: "0.15", pcSum: 0 },
  ],
  overlays: [{ name: "Concrete sub", amount: 5000 }],
  overlap: 0,
  reference: null,
  ...over,
});

describe("assembled tender estimate", () => {
  it("runs the whole chain: build-up, QS, commercial stack, consolidated package, auto schedule", () => {
    const e = computeTenderEstimate(inputs());
    expect(s(e.qs.totalDirect)).toBe("10000");
    expect(s(e.tender.preMarginTotal)).toBe("200");
    expect(s(e.tender.subtotal)).toBe("10200");
    expect(s(e.tender.overhead)).toBe("1020");
    expect(s(e.tender.profit)).toBe("1980");
    expect(s(e.tender.tenderExclGst)).toBe("13200");
    // package: (10,200 + 5,000) cost, +10% overhead = 16,720, / 0.85
    expect(s(cents(e.consolidated.allInTender))).toBe("19670.59");
    expect(e.schedule.reconciles).toBe(true);
    expect(s(e.schedule.total)).toBe("19670.59");
    expect(e.scheduleIsAuto).toBe(true);
    expect(e.edited).toBe(true);
    expect(e.qaCounts).toEqual({ OK: 1 });
  });

  it("feeds CA01 from Risk Truth and CA16 from the selected Management Reserve", () => {
    const blank = Object.fromEntries(
      ["ref", "risk_id", "consequence", "driver", "cost_ref", "treatment", "baseline_amount", "residual", "mode", "qty", "unit", "unit_rate", "probability", "provision", "owner", "distinct", "target", "include", "overlap_group", "embedded", "evidence", "evidence_note", "integration_complete", "basis", "action", "source"].map((k) => [k, ""]),
    );
    const e = computeTenderEstimate(
      inputs({
        commercial: [
          { ref: "CA01", name: "Design risk", method: "Risk Engine", include: "Yes", pct: 0, pcSum: 0 },
          { ref: "CA16", name: "Management reserve", method: "Fixed Amount", include: "Yes", pct: 0, pcSum: 0 },
          { ref: "CA17", name: "Overhead", method: "Markup %", include: "Yes", pct: "0.10", pcSum: 0 },
          { ref: "CA18", name: "Profit", method: "Margin %", include: "Yes", pct: "0.15", pcSum: 0 },
        ],
        riskTruth: [{ id: "X-0001", ...blank, ref: "RT01-001", consequence: "x", mode: "Fixed Allowance", provision: "500", include: "Yes", distinct: "Yes", target: "CA01", evidence: "AMBER", integration_complete: "Yes" } as never],
        managementReserve: { items: [], selected: "1000", selected_basis: "Approved", adjudicated_by: "", adjudicated_on: "" },
        overlays: [],
      }),
    );
    expect(s(e.tender.additions.get("CA01"))).toBe("500");
    expect(s(e.tender.additions.get("CA16"))).toBe("1000");
    expect(s(e.tender.subtotal)).toBe("11500");
    expect(e.reserve).not.toBeNull();
    // the reserve's sell factor is the stack's own: 1.1 / 0.85
    expect(Math.abs(Number(e.reserve!.factor.toString()) - 1.1 / 0.85)).toBeLessThan(1e-9);
  });

  it("reconciles against a workbook's displayed values when given", () => {
    const e = computeTenderEstimate(inputs({ reference: { "Base direct estimate": 10000, "Own works tender excl. GST": 13200.01 } }));
    expect(e.reconciliation.map((r) => [r.name, r.ok])).toEqual([["Base direct estimate", true], ["Own works tender excl. GST", false]]);
    expect(e.reconciled).toBe(false);
    expect(s(e.reconciliation[1]!.difference)).toBe("-0.01");
  });
});
