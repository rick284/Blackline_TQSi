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
    expect(r.warnings).toEqual([]);
  });
  it("moves the forecast and the margin when a person says a line will cost more", () => {
    const r = K.costControl({ ...ledger, forecasts: [{ code: "EW01", etc: "45000.00" }] });
    expect([s(line(r, "EW01").forecastFinal), s(line(r, "EW01").variance), line(r, "EW01").status, line(r, "EW01").etcManual]).toEqual(["48000", "-8000", "Over Budget", true]);
    expect([s(r.project.forecastFinalCost), s(r.project.forecastFinalProfit), s(r.project.forecastFinalMarginPct), s(r.project.marginDrift)]).toEqual(["88000", "12000", "12", "-8"]);
    expect(r.warnings.map((w) => [w.severity, w.warning_type, w.title])).toEqual([["Critical", "Margin Drop", "Forecast margin dropped to 12.0%"], ["High", "Forecast Overrun", "Forecast overrun: EW01 Earthworks"]]);
    expect(r.warnings[1]!.description).toBe("Forecast to finish $8,000.00 over its budget.");
  });
  it("flags a line that is over by less than 5% as one to watch", () => {
    const r = K.costControl({ ...ledger, forecasts: [{ code: "EW01", etc: "38000.00" }] });
    expect([line(r, "EW01").status, r.warnings[0]!.severity, r.warnings[0]!.description]).toEqual(["Watch", "Medium", "Forecast to finish $1,000.00 over its budget (less than 5%)."]);
  });
  it("ignores voided entries and says when an order has been invoiced for more than it was", () => {
    const voided = K.costControl({ ...ledger, actuals: ledger.actuals.map((a) => (a.id === "a2" ? { ...a, voided: true } : a)), commitments: [po({ id: "x", voided: true })] });
    expect(s(line(voided, "EW01").actual)).toBe("500");
    const over = K.costControl(base({ commitments: [po()], actuals: [act({ code: "SUB-01", amount: "12000.00", commitmentId: "po1", supplier: "Allied" })] }));
    expect(over.commitments[0]).toMatchObject({ overBilled: true });
    expect(s(over.commitments[0]!.remaining)).toBe("0");
    expect(over.warnings.find((w) => w.warning_type === "Order Over-invoiced")!.description).toBe("Invoiced $2,000.00 more than the order of $10,000.00.");
    expect(over.warnings.find((w) => w.warning_type === "Cost Overrun")).toMatchObject({ severity: "High", title: "Cost overrun: SUB-01 Concrete sub" }); // QSi's own rule on the same line
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
    expect(r.warnings.map((w) => w.warning_type)).toContain("Claimed Over Contract");
  });
  it("leaves out voided claims", () => {
    expect(s(K.costControl(base({ claims: [claim({ voided: true })] })).claimed.value)).toBe("0");
  });
});

describe("QSi's warnings, on Blackline's records", () => {
  const today = "2026-11-10";
  const variation = (o: Partial<K.Variation>): K.Variation => ({ id: "v1", ref: "V07", title: "Extra kerb", status: "pending", sell: "5000.00", lines: [], note: "", ...o });
  const claim = (o: Partial<K.Claim>): K.Claim => ({ id: "c", seq: 3, periodEnd: "2026-10-31", valueEx: "20000.00", retentionPct: "5", status: "submitted", paidAmount: "0", voided: false, submittedOn: "2026-10-26", ...o });
  const kinds = (r: K.CostSummary) => r.warnings.map((w) => [w.severity, w.warning_type, w.title]);

  it("a variation sent to the client and not answered by the day they were to reply, in the person's own numbering", () => {
    const r = K.costControl(base({ variations: [variation({ submittedOn: "2026-10-30", responseDue: "2026-11-06" })] }), { today });
    expect(kinds(r)).toEqual([["Medium", "Variation Response Overdue", "V07: Response overdue"]]);
    expect(r.warnings[0]!.description).toBe("Submitted variation response was due 2026-11-06.");
    expect(kinds(K.costControl(base({ variations: [variation({ submittedOn: "2026-10-30", responseDue: "2026-11-10" })] }), { today }))).toEqual([]); // due today is not late
  });

  it("work proceeding at risk, and a variation sent with no price", () => {
    expect(kinds(K.costControl(base({ variations: [variation({ atRisk: true })] }), { today }))).toEqual([["High", "Work Proceeding At Risk", "V07: Work proceeding without approval"]]);
    expect(kinds(K.costControl(base({ variations: [variation({ submittedOn: "2026-10-30", sell: "0.00" })] }), { today }))).toEqual([["Medium", "Variation No Pricing", "V07: No pricing line items"]]);
    expect(kinds(K.costControl(base({ variations: [variation({ status: "approved", atRisk: true, submittedOn: "2026-10-01", responseDue: "2026-10-05" })] }), { today }))).toEqual([]); // decided: nothing to chase
  });

  it("a claim not paid within the contract's working days is Critical, counted from the day it went in and skipping weekends", () => {
    // sent Mon 26 Oct 2026; 10 working days later is Mon 9 Nov
    expect(K.addWorkingDays("2026-10-26", 10)).toBe("2026-11-09");
    expect(K.addWorkingDays("2026-10-30", 1)).toBe("2026-11-02"); // Friday plus one working day is Monday
    const r = K.costControl(base({ payDays: "10", claims: [claim({})] }), { today });
    expect(kinds(r)).toEqual([["Critical", "Payment Overdue", "Claim 3: Payment overdue"]]);
    expect(r.warnings[0]!.description).toBe("Payment was due 2026-11-09.");
    expect(kinds(K.costControl(base({ payDays: "15", claims: [claim({})] }), { today }))).toEqual([]); // not due yet
    expect(kinds(K.costControl(base({ claims: [claim({})] }), { today }))).toEqual([]); // the contract says nothing: no date to be late against
    expect(kinds(K.costControl(base({ payDays: "10", claims: [claim({ status: "draft", submittedOn: null })] }), { today }))).toEqual([]);
  });

  it("a claim paid for less than was owed is a part payment", () => {
    // 20,000 less 5% retention, plus GST = 21,850
    const r = K.costControl(base({ claims: [claim({ status: "paid", paidAmount: "15000.00" })] }), { today });
    expect(kinds(r)).toEqual([["Medium", "Part Paid Claim", "Claim 3: Only partially paid"]]);
    expect(r.warnings[0]!.description).toBe("Paid $15,000.00 of $21,850.00 due.");
    expect(kinds(K.costControl(base({ claims: [claim({ status: "paid", paidAmount: "21850.00" })] }), { today }))).toEqual([]);
  });

  it("a programme activity past its planned finish and not complete", () => {
    const r = K.costControl(base(), { today, activities: [{ activity_code: "1.2", activity_name: "Strip topsoil", planned_finish: "2026-11-05", status: "In Progress" }, { activity_code: "1.3", activity_name: "Done", planned_finish: "2026-11-01", status: "Complete" }] });
    expect(kinds(r)).toEqual([["Medium", "Activity Delayed", "Activity delayed: 1.2: Strip topsoil"]]);
  });

  it("a risk allowance and the preliminaries are recognised by what they are, so QSi's special rules apply", () => {
    const withKinds: K.Ledger = base({
      budget: [...budget, { code: "PG01", description: "Project preliminaries", section: "Preliminaries & General", amount: "5000.00", kind: "qs" }, { code: "CA02", description: "Construction residual risk", section: "Allowances", amount: "4000.00", kind: "allowance" }],
      actuals: [act({ code: "PG01", amount: "5600.00" }), act({ id: "r", code: "CA02", amount: "3500.00" })],
    });
    const r = K.costControl(withKinds, { today });
    expect(r.warnings.map((w) => w.warning_type)).toEqual(expect.arrayContaining(["Preliminaries Overrun", "Risk Allowance Consumed"]));
    expect(r.warnings.find((w) => w.warning_type === "Risk Allowance Consumed")!.title).toBe("Risk allowance 88% consumed: CA02 Construction residual risk");
  });

  it("is most serious first", () => {
    const r = K.costControl(base({ commitments: [po()], actuals: [act({ code: "SUB-01", amount: "12000.00", commitmentId: "po1" })], variations: [variation({ atRisk: true })] }), { today });
    const order = ["Critical", "High", "Medium", "Low"];
    expect(r.warnings.map((w) => order.indexOf(w.severity))).toEqual([...r.warnings.map((w) => order.indexOf(w.severity))].sort());
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
