import { describe, expect, it } from "vitest";
import * as K from "../src/costControl.js";

const budget: K.BudgetLineIn[] = [
  { code: "EW01", description: "Earthworks", section: "Earthworks", amount: "40000.00" },
  { code: "PV01", description: "Pavements", section: "Pavements", amount: "30000.00" },
  { code: "SUB-01", description: "Concrete sub", section: "Subcontract packages", amount: "10000.00" },
];
const act = (o: Partial<K.Actual>): K.Actual => ({ id: "a", code: "EW01", kind: "invoice", supplier: "", ref: "", description: "", amount: "0", hours: "", date: "2026-11-01", commitmentId: null, voided: false, ...o });
const po = (o: Partial<K.Commitment> = {}): K.Commitment => ({ id: "po1", code: "SUB-01", supplier: "Allied", ref: "PO-1", description: "", amount: "10000.00", date: "2026-11-01", voided: false, ...o });
const base = (o: Partial<K.Ledger> = {}): K.Ledger => ({ contractSum: "100000.00", budget, commitments: [], actuals: [], variations: [], forecasts: [], claims: [], ...o });
const line = (r: K.CostSummary, code: string) => r.lines.find((l) => l.code === code)!;
const s = (x: { toString(): string }) => x.toString();

describe("committed, spent and forecast", () => {
  const ledger = base({
    commitments: [po()],
    actuals: [
      act({ id: "a1", code: "SUB-01", amount: "4000.00", commitmentId: "po1" }), act({ id: "a2", amount: "2500.00" }),
      act({ id: "a3", kind: "labour", amount: "1000.00", hours: "10" }), act({ id: "a4", amount: "-500.00" }),
    ],
  });
  it("counts as committed only what has not yet been invoiced against the order", () => {
    const r = K.costControl(ledger);
    expect(r.commitments[0]).toMatchObject({ billed: expect.anything(), overBilled: false });
    expect([s(r.commitments[0]!.billed), s(r.commitments[0]!.remaining)]).toEqual(["4000", "6000"]);
    expect([s(line(r, "SUB-01").actual), s(line(r, "SUB-01").committed), s(line(r, "SUB-01").forecastFinal)]).toEqual(["4000", "6000", "10000"]);
  });
  it("takes credits off the cost, and assumes no overrun until someone says so", () => {
    const r = K.costControl(ledger);
    expect([s(line(r, "EW01").actual), s(line(r, "EW01").etc), s(line(r, "EW01").forecastFinal), line(r, "EW01").etcManual, line(r, "EW01").status]).toEqual(["3000", "37000", "40000", false, "Tracking OK"]);
    expect([s(r.project.actualCostToDate), s(r.project.forecastFinalCost), s(r.project.forecastFinalProfit), s(r.project.forecastFinalMarginPct), s(r.project.actualLabourHours)]).toEqual(["7000", "80000", "20000", "20", "10"]);
    expect(r.alerts).toEqual([]);
  });
  it("moves the forecast and the margin when a person says a line will cost more", () => {
    const r = K.costControl({ ...ledger, forecasts: [{ code: "EW01", etc: "45000.00" }] });
    expect([s(line(r, "EW01").forecastFinal), s(line(r, "EW01").variance), line(r, "EW01").status, line(r, "EW01").etcManual]).toEqual(["48000", "-8000", "Over Budget", true]);
    expect([s(r.project.forecastFinalCost), s(r.project.forecastFinalProfit), s(r.project.forecastFinalMarginPct), s(r.project.marginDrift)]).toEqual(["88000", "12000", "12", "-8"]);
    expect(r.alerts).toEqual(["EW01 Earthworks is forecast to finish $8,000.00 over its budget.", "The margin is forecast to finish at 12%, down from 20% at award."]);
  });
  it("flags a line that is over by less than 5% as one to watch", () => {
    const r = K.costControl({ ...ledger, forecasts: [{ code: "EW01", etc: "38000.00" }] });
    expect([line(r, "EW01").status, r.alerts[0]]).toEqual(["Watch", "EW01 Earthworks is forecast to finish $1,000.00 over its budget (less than 5%)."]);
  });
  it("ignores voided entries and says when an order has been invoiced for more than it was", () => {
    const voided = K.costControl({ ...ledger, actuals: ledger.actuals.map((a) => (a.id === "a2" ? { ...a, voided: true } : a)), commitments: [po({ id: "x", voided: true })] });
    expect(s(line(voided, "EW01").actual)).toBe("500");
    const over = K.costControl(base({ commitments: [po()], actuals: [act({ code: "SUB-01", amount: "12000.00", commitmentId: "po1", supplier: "Allied" })] }));
    expect(over.commitments[0]).toMatchObject({ overBilled: true });
    expect(s(over.commitments[0]!.remaining)).toBe("0");
    expect(over.alerts.some((a) => a.includes("invoiced $2,000.00 more than its order"))).toBe(true);
  });
});

describe("variations", () => {
  const variations: K.Variation[] = [
    { id: "v1", ref: "V01", title: "Extra kerb and PV widening", status: "approved", sell: "5000.00", lines: [{ code: "PV01", description: "", amount: "3000.00" }, { code: "VAR-01", description: "Extra kerb", amount: "1200.00" }], note: "" },
    { id: "v2", ref: "V02", title: "Not agreed yet", status: "pending", sell: "2000.00", lines: [{ code: "EW01", description: "", amount: "1500.00" }], note: "" },
    { id: "v3", ref: "V03", title: "Declined", status: "rejected", sell: "9999.00", lines: [{ code: "EW01", description: "", amount: "9999.00" }], note: "" },
  ];
  it("move the budget and the contract sum only when approved, and add new lines", () => {
    const r = K.costControl(base({ variations }));
    expect([s(line(r, "PV01").revised), s(line(r, "PV01").variations), s(line(r, "EW01").revised)]).toEqual(["33000", "3000", "40000"]);
    expect(line(r, "VAR-01")).toMatchObject({ description: "Extra kerb", section: "Variations" });
    expect(s(line(r, "VAR-01").revised)).toBe("1200");
    expect([s(r.project.currentContractValue), s(r.project.revisedBudget)]).toEqual(["105000", "84200"]);
    // the pending variation is reported beside them, and kept out of the forecast margin
    expect([r.pending.count, s(r.pending.sell), s(r.pending.cost)]).toEqual([1, "2000", "1500"]);
    expect([s(r.project.forecastFinalProfit), s(r.project.forecastFinalMarginPct)]).toEqual(["20800", "19.81"]);
  });
  it("make the new code something entries can be booked to", () => {
    expect(K.codesOf(budget, variations).map((c) => c.code)).toEqual(["EW01", "PV01", "SUB-01", "VAR-01"]);
    expect(K.codesOf(budget, variations.slice(1)).map((c) => c.code)).toEqual(["EW01", "PV01", "SUB-01"]);
  });
});

describe("claims and retention", () => {
  const claim = (o: Partial<K.Claim>): K.Claim => ({ id: "c", seq: 1, periodEnd: "2026-11-30", valueEx: "20000.00", retentionPct: "5", status: "submitted", paidAmount: "0", voided: false, ...o });
  it("holds back retention at the percentage the claim was made at, and adds GST to what is owed", () => {
    const r = K.costControl(base({ claims: [claim({ id: "c1", paidAmount: "21850.00", status: "paid" }), claim({ id: "c2", seq: 2, valueEx: "30000.00", periodEnd: "2026-12-31" }), claim({ id: "c3", seq: 3, status: "draft", valueEx: "5000.00" })] }));
    expect(r.claims.map((c) => [s(c.retention), s(c.netEx), s(c.netInc), s(c.cumulativeValue)])).toEqual([["1000", "19000", "21850", "20000"], ["1500", "28500", "32775", "50000"], ["250", "4750", "5462.5", "55000"]]);
    expect([s(r.claimed.value), s(r.claimed.retentionHeld), s(r.claimed.netInc), s(r.claimed.paid), s(r.claimed.outstanding), s(r.claimed.pctOfContract)]).toEqual(["50000", "2500", "54625", "21850", "32775", "50"]);
  });
  it("takes no retention when none is held, and warns when more than the contract has been claimed", () => {
    const r = K.costControl(base({ claims: [claim({ retentionPct: "0", valueEx: "110000.00" })] }));
    expect([s(r.claims[0]!.retention), s(r.claims[0]!.netEx)]).toEqual(["0", "110000"]);
    expect(r.alerts).toContain("More than the whole contract has been claimed.");
  });
  it("leaves out voided claims", () => {
    expect(s(K.costControl(base({ claims: [claim({ voided: true })] })).claimed.value)).toBe("0");
  });
});

describe("checking what a person types", () => {
  const codes = new Set(["EW01", "SUB-01"]);
  it("takes dollars and cents, and a credit only where it makes sense", () => {
    expect(K.parseMoney("$1,250.5")).toBe("1250.50");
    expect(() => K.parseMoney("-5")).toThrow("negative");
    expect(K.parseMoney("-5", { allowNegative: true })).toBe("-5.00");
    expect(() => K.parseMoney("1.234")).toThrow("dollars and cents");
    expect(() => K.parseDate("2026-02-30")).toThrow("real date");
  });
  it("commitments and actuals must be booked to a line in the budget", () => {
    expect(K.cleanCommitment({ code: "EW01", supplier: "Allied", amount: "$5,000", date: "2026-11-01" }, codes)).toMatchObject({ amount: "5000.00" });
    expect(() => K.cleanCommitment({ code: "ZZ99", supplier: "A", amount: "1", date: "2026-11-01" }, codes)).toThrow("isn't a line in the control budget");
    expect(() => K.cleanCommitment({ code: "EW01", supplier: "", amount: "1", date: "2026-11-01" }, codes)).toThrow("supplier is needed");
    expect(K.cleanActual({ code: "EW01", kind: "labour", amount: "-100", hours: "7.5", date: "2026-11-01" }, codes)).toMatchObject({ amount: "-100.00", hours: "7.5", kind: "labour" });
    expect(() => K.cleanActual({ code: "EW01", kind: "gift", amount: "1", date: "2026-11-01" }, codes)).toThrow("kind must be");
    expect(() => K.cleanActual({ code: "EW01", amount: "0", date: "2026-11-01" }, codes)).toThrow("can't be nothing");
    expect(() => K.cleanActual({ code: "EW01", amount: "5", hours: "lots", date: "2026-11-01" }, codes)).toThrow("Hours");
  });
  it("variations: a new line needs its description, an existing one doesn't", () => {
    const ok = K.cleanVariation({ title: "Extra kerb", sell: "5000", lines: [{ code: "EW01", amount: "1000" }, { code: "VAR-01", description: "Kerb", amount: "-200" }] }, codes);
    expect(ok.lines.map((l) => [l.code, l.amount])).toEqual([["EW01", "1000.00"], ["VAR-01", "-200.00"]]);
    expect(() => K.cleanVariation({ title: "x", sell: "1", lines: [{ code: "VAR-01", amount: "1" }] }, codes)).toThrow("description");
    expect(() => K.cleanVariation({ title: "x", sell: "1", lines: [{ code: "EW01", amount: "1" }, { code: "EW01", amount: "2" }] }, codes)).toThrow("twice");
    expect(() => K.cleanVariation({ title: " ", sell: "1" }, codes)).toThrow("title is needed");
  });
  it("forecasts clear with a blank, and claims need a value and a date", () => {
    expect(K.cleanForecast({ code: "EW01", etc: "" }, codes)).toEqual({ code: "EW01", etc: null, note: "" });
    expect(K.cleanForecast({ code: "EW01", etc: "$4,500" }, codes).etc).toBe("4500.00");
    expect(K.cleanClaim({ periodEnd: "2026-11-30", valueEx: "20000" })).toMatchObject({ valueEx: "20000.00" });
    expect(() => K.cleanClaim({ periodEnd: "soon", valueEx: "1" })).toThrow("real date");
  });
});
