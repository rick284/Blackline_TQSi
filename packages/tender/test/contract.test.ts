import { describe, expect, it } from "vitest";
import { computeTenderEstimate, type TenderInputs } from "../src/index.js";
import * as C from "../src/contract.js";

const inputs: TenderInputs = {
  library: [{ code: "SUB", description: "Subcontract", unit: "ea", baseRate: "1" }],
  qs: [
    { code: "EW01", section: "Earthworks", description: "Bulk earthworks", unit: "m3", quantity: "1000" },
    { code: "PV01", section: "Pavements", description: "Basecourse", unit: "m2", quantity: "500" },
  ],
  rows: [
    { qsCode: "EW01", mode: "Lump Sum / Quote", resourceType: "Subcontract", resourceCode: "SUB", manualQty: "1", jobRateOverride: "10000.333", verified: "Yes", uid: "EW01-001" },
    { qsCode: "PV01", mode: "Lump Sum / Quote", resourceType: "Subcontract", resourceCode: "SUB", manualQty: "1", jobRateOverride: "4000", verified: "Yes", uid: "PV01-001" },
  ],
  weatherLinks: { dailyUid: "", hoursPerDay: 8, weeklyUids: [] },
  tool: { exposedPool: 0, rainWetGroundCost: 0, criticalPathDelayWd: 0, additionalBilledWeeks: 0 },
  commercial: [
    { ref: "CA05", name: "Site establishment", method: "PC Sum", include: "Yes", pct: "0", pcSum: "2500" },
    { ref: "CA17", name: "Overhead", method: "Markup %", include: "Yes", pct: "0.10", pcSum: "0" },
    { ref: "CA18", name: "Profit", method: "Margin %", include: "Yes", pct: "0.15", pcSum: "0" },
  ],
  overlays: [{ name: "Concrete sub", amount: "5000" }, { name: "Drainage sub", amount: "3000.50" }],
  overlap: "0",
  reference: null,
};

describe("the control budget copied from an estimate", () => {
  const e = computeTenderEstimate(inputs);
  const b = C.budgetFrom(e, inputs);

  it("has a line for each QS item, allowance and subcontract package, with the estimate's own codes", () => {
    expect(b.lines.map((l) => [l.code, l.kind, l.section, l.amount])).toEqual([
      ["EW01", "qs", "Earthworks", "10000.33"], ["PV01", "qs", "Pavements", "4000.00"],
      ["CA05", "allowance", "Allowances", "2500.00"],
      ["SUB-01", "subcontract", "Subcontract packages", "5000.00"], ["SUB-02", "subcontract", "Subcontract packages", "3000.50"],
    ]);
    expect(b.lines.map((l) => l.source)).toEqual(["qs:EW01", "qs:PV01", "ca:CA05", "overlay:Concrete sub", "overlay:Drainage sub"]);
    expect(b.lines.map((l) => l.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it("adds up to the estimate's known cost, and the margin is what the all-in holds above it", () => {
    expect(b.cost).toBe("24500.83");
    expect(Number(b.cost)).toBeCloseTo(Number(e.consolidated.grossKnownPackage.toString()), 1);
    expect(b.allIn).toBe(e.consolidated.allInTender.toFixed(2));
    expect(Number(b.margin)).toBeCloseTo(Number(b.overhead) + Number(b.bonds) + Number(b.finance) + Number(b.profit), 1);
    expect(Number(b.allIn) - Number(b.cost)).toBeCloseTo(Number(b.margin), 2);
  });

  it("leaves out lines that carry nothing, and totals by section", () => {
    const none = C.budgetFrom(computeTenderEstimate({ ...inputs, overlays: [{ name: "Empty", amount: "0" }] }), { overlays: [{ name: "Empty", amount: "0" }] });
    expect(none.lines.some((l) => l.kind === "subcontract")).toBe(false);
    expect(C.bySection(b.lines)).toEqual([
      { section: "Earthworks", amount: "10000.33", lines: 1 }, { section: "Pavements", amount: "4000.00", lines: 1 },
      { section: "Allowances", amount: "2500.00", lines: 1 }, { section: "Subcontract packages", amount: "8000.50", lines: 2 },
    ]);
  });
});

describe("the contract sum and terms", () => {
  it("takes dollars and cents above zero", () => {
    expect(C.parseSum("$1,250,000")).toBe("1250000.00");
    expect(C.parseSum("99.5")).toBe("99.50");
    for (const bad of ["", "0", "-5", "lots", "1.234"]) expect(() => C.parseSum(bad)).toThrow("contract sum");
  });
  it("checks each term as a person would expect, and keeps what it wasn't told to change", () => {
    const t = C.cleanTerms({ form: "NZS 3910:2023", startDate: "2026-11-02", completionDate: "2027-03-31", payDays: "20", retentionPct: "5", defectsMonths: "12", ldPerDay: "$500" });
    expect(t).toMatchObject({ form: "NZS 3910:2023", payDays: "20", retentionPct: "5", ldPerDay: "500", claimDay: "" });
    expect(C.cleanTerms({ claimDay: "25th" }, t)).toMatchObject({ claimDay: "25th", form: "NZS 3910:2023", payDays: "20" });
    expect(() => C.cleanTerms({ form: "My own form" })).toThrow("form must be one of");
    expect(() => C.cleanTerms({ startDate: "2026-02-30" })).toThrow("real date");
    expect(() => C.cleanTerms({ retentionPct: "50" })).toThrow("between 0 and 20");
    expect(() => C.cleanTerms({ payDays: "twenty" })).toThrow("whole number");
    expect(() => C.cleanTerms({ ldPerDay: "a lot" })).toThrow("dollar amount");
    expect(() => C.cleanTerms({ completionDate: "2026-10-01" }, t)).toThrow("before the start");
    expect(() => C.cleanTerms({ colour: "red" } as never)).toThrow("isn't part");
  });
});
