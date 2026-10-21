import { describe, expect, it } from "vitest";
import { type CostData, ledgerOf, openOrders, summaryOf, variationLines } from "../src/lib/costWeb.js";

const data: CostData = {
  contract: {
    contractSum: "30000.00", tenderAllIn: "30000.00", awardedOn: "2026-11-01", revision: { label: "Rev A" },
    terms: { form: "", contractNumber: "", clientRef: "", startDate: "", completionDate: "", claimDay: "", payDays: "", retentionPct: "5", retentionNote: "", defectsMonths: "", ldPerDay: "", notes: "" },
    lines: [{ seq: 1, code: "EW01", description: "Earthworks", section: "Earthworks", kind: "qs", source: "qs:EW01", amount: "10000.00" }, { seq: 2, code: "SUB-01", description: "Concrete sub", section: "Subcontract packages", kind: "subcontract", source: "overlay:Concrete sub", amount: "5000.00" }],
    budget: { cost: "15000.00", margin: "15000.00", marginPct: "50.00" },
  },
  commitments: [
    { id: "po1", code: "SUB-01", supplier: "Allied", ref: "PO-1", description: "", amount: "5000.00", date: "2026-11-02", voided: false, voidReason: null, createdBy: "Eli", createdAt: "" },
    { id: "po2", code: "SUB-01", supplier: "Gone", ref: "PO-2", description: "", amount: "100.00", date: "2026-11-02", voided: true, voidReason: "Wrong job", createdBy: "Eli", createdAt: "" },
  ],
  actuals: [{ id: "a1", code: "SUB-01", kind: "invoice", supplier: "Allied", ref: "I1", description: "", amount: "2000.00", hours: "", date: "2026-11-05", commitmentId: "po1", voided: false, voidReason: null, createdBy: "Eli", createdAt: "" }],
  variations: [], forecasts: [], claims: [],
};

describe("the cost summary on the screen", () => {
  it("is the shared engine's answer from the server's raw ledger", () => {
    const r = summaryOf(data);
    expect(r.lines.map((l) => [l.code, l.actual.toString(), l.committed.toString(), l.forecastFinal.toString()])).toEqual([["EW01", "0", "0", "10000"], ["SUB-01", "2000", "3000", "5000"]]);
    expect(ledgerOf(data).budget[0]).toEqual({ code: "EW01", description: "Earthworks", section: "Earthworks", amount: "10000.00" });
    expect(r.project.forecastFinalMarginPct.toString()).toBe("50");
  });
  it("offers only live orders on the line being booked to", () => {
    expect(openOrders(data, "SUB-01").map((c) => c.id)).toEqual(["po1"]);
    expect(openOrders(data, "EW01")).toEqual([]);
  });
  it("ignores empty rows on a variation", () => {
    expect(variationLines([{ code: "EW01", description: "", amount: "100" }, { code: " ", description: "", amount: "" }])).toHaveLength(1);
  });
});
