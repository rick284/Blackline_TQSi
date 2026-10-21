import { describe, expect, it } from "vitest";
import { activitiesOf, type CostData, ledgerOf, openOrders, summaryOf, variationLines } from "../src/lib/costWeb.js";

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
    expect(ledgerOf(data).budget[0]).toEqual({ code: "EW01", description: "Earthworks", section: "Earthworks", amount: "10000.00", kind: "qs" });
    expect(r.project.forecastFinalMarginPct.toString()).toBe("50");
  });
  it("offers only live orders on the line being booked to", () => {
    expect(openOrders(data, "SUB-01").map((c) => c.id)).toEqual(["po1"]);
    expect(openOrders(data, "EW01")).toEqual([]);
  });
  it("turns the Gantt's tasks into programme activities, leaving out headings and inactive tasks, and warns about a late one", () => {
    const acts = activitiesOf([
      { wbs: "1", name: "Earthworks", finish: "2026-11-05T17:00:00", percent: 40, summary: true, active: true },
      { wbs: "1.1", name: "Strip topsoil", finish: "2026-11-05T17:00:00", percent: 60, summary: false, active: true },
      { wbs: "1.2", name: "Cut to level", finish: "2026-11-04T17:00:00", percent: 100, summary: false, active: true },
      { wbs: "1.3", name: "Dropped", finish: "2026-11-01T17:00:00", percent: 0, summary: false, active: false },
    ]);
    expect(acts).toEqual([
      { activity_code: "1.1", activity_name: "Strip topsoil", planned_finish: "2026-11-05", status: "In Progress" },
      { activity_code: "1.2", activity_name: "Cut to level", planned_finish: "2026-11-04", status: "Complete" },
    ]);
    const r = summaryOf(data, { today: "2026-11-10", activities: acts });
    expect(r.warnings.map((w) => w.title)).toEqual(["Activity delayed: 1.1: Strip topsoil"]);
  });
  it("ignores empty rows on a variation", () => {
    expect(variationLines([{ code: "EW01", description: "", amount: "100" }, { code: " ", description: "", amount: "" }])).toHaveLength(1);
  });
});
