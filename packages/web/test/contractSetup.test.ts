import { describe, expect, it } from "vitest";
import { splitIntoPackages, type TenderInputs } from "@blackline/tender/core";
import { budgetCsv, previewBudget, todayYmd } from "../src/lib/contractSetup.js";

const inputs: TenderInputs = {
  library: [{ code: "SUB", description: "Subcontract", unit: "ea", baseRate: "1" }],
  qs: [{ code: "EW01", section: "Earthworks", description: "Bulk earthworks, strip & stockpile", unit: "m3", quantity: "1000" }],
  rows: [{ qsCode: "EW01", mode: "Lump Sum / Quote", resourceType: "Subcontract", resourceCode: "SUB", manualQty: "1", jobRateOverride: "10000", verified: "Yes", uid: "EW01-001" }],
  weatherLinks: { dailyUid: "", hoursPerDay: 8, weeklyUids: [] }, tool: { exposedPool: 0, rainWetGroundCost: 0, criticalPathDelayWd: 0, additionalBilledWeeks: 0 },
  commercial: [{ ref: "CA17", name: "Overhead", method: "Markup %", include: "Yes", pct: "0.1", pcSum: "0" }], overlays: [{ name: "Concrete sub", amount: "5000" }], overlap: "0", reference: null,
};

describe("the budget an award would copy", () => {
  const records = splitIntoPackages(inputs).flatMap((p) => Object.entries(p.records).map(([id, data]) => ({ id, data })));
  it("is worked out from a revision's records with the shared rule", () => {
    const b = previewBudget(records);
    expect(b.lines.map((l) => [l.code, l.amount])).toEqual([["EW01", "10000.00"], ["SUB-01", "5000.00"]]);
    expect(b.cost).toBe("15000.00");
    expect(Number(b.allIn)).toBeGreaterThan(15000);
  });
  it("writes the budget as CSV, quoting commas and keeping the totals", () => {
    const csv = budgetCsv("329 Hobsonville Road", previewBudget(records).lines, { contractSum: "17000.00", cost: "15000.00", margin: "2000.00" });
    const rows = csv.trim().split("\r\n");
    expect(rows[3]).toBe('EW01,"Bulk earthworks, strip & stockpile",Earthworks,qs,10000.00');
    expect(rows.slice(-3)).toEqual([",Control budget (cost),,,15000.00", ",Margin held in the contract sum,,,2000.00", ",Contract sum,,,17000.00"]);
  });
  it("dates the award by the person's own calendar day", () => {
    expect(todayYmd(new Date(2026, 10, 3, 23, 59))).toBe("2026-11-03");
  });
});
