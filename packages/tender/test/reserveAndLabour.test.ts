/** Ported from QSi Pro engine/tests/test_management_reserve.py and test_labour_rate.py (the parts that need no client files). */
import { describe, expect, it } from "vitest";
import { cents, D } from "@blackline/engine";
import { labourRate as lr, managementReserve as mr } from "../src/index.js";

const F = new D("1.1").div("0.85"); // 10% overhead, 15% true margin
const s = (x: { toString(): string } | null) => (x === null ? null : x.toString());
const near = (a: { minus(x: D | number | string): { abs(): { lt(x: string): boolean } } }, b: string, tol = "0.01") => a.minus(b).abs().lt(tol);

function block(items: Partial<Record<(typeof mr.ITEM_FIELDS)[number], string>>[], selected = "", basis = "") {
  const b = mr.newBlock(selected, basis);
  items.forEach((v, i) => b.items.push(mr.buildItem(`M-t${String(i).padStart(4, "0")}`, v, b.items)));
  return b;
}

describe("management reserve", () => {
  it("reproduces the policy worked example (Hobsonville Rev34)", () => {
    const b = block(
      [
        { title: "Rev17 vs Yodha earthworks", impact: "28600", basis: "Sell", probability_low: "0.55", probability_high: "0.65" },
        { title: "Ramp / entry / stairs ownership", impact: "9500", basis: "Sell", probability_low: "0.30", probability_high: "0.40" },
        { title: "Retaining 1.5m vs 1.8m", impact: "0", basis: "Sell", probability_low: "0.8" },
        { title: "PV01 productivity", impact_status: "Unquantified", probability_low: "0.5" },
      ],
      "18269.06",
    );
    const r = mr.computeReserve(b, F);
    expect(near(r.weightedLowSell, "18580")).toBe(true);
    expect(near(r.weightedHighSell, "22390")).toBe(true);
    expect(near(r.weightedMidSell, "20485")).toBe(true);
    expect(r.unquantifiedItems).toBe(1);
    expect(r.unknownItems).toBe(0);
    // the reserve is a pre-margin cost: 18,269.06 sells for 23,642, above the sell range at 10% / 15%
    expect(r.position).toBe("above");
    expect(near(r.selectedSell!, "23642.31")).toBe(true);
    expect(r.items.map((i) => i.counted)).toEqual([true, true, true, false]);
    expect(r.items[3]!.weightedLow).toBeNull();
  });

  it("never turns an unknown probability into dollars", () => {
    const r = mr.computeReserve(block([{ title: "X", impact: "10000", basis: "Cost", probability_low: "0.5", prob_status: "UNKNOWN" }], "1000", "why"), F);
    expect(r.weightedHigh.isZero()).toBe(true);
    expect(r.unknownItems).toBe(1);
    expect(s(r.items[0]!.sensitivity)).toBe("10000");
    expect(r.items[0]!.status).toBe("RED");
    expect(mr.computeReserve(block([{ title: "No probability given", impact: "10000", basis: "Cost" }], "1000"), F).items[0]!.weightedLow).toBeNull();
  });

  it("converts sell-basis items and leaves cost-basis items alone", () => {
    const r = mr.computeReserve(block([{ title: "c", impact: "1000", basis: "Cost", probability_low: "0.5" }, { title: "s", impact: "1000", basis: "Sell", probability_low: "0.5" }]), F);
    expect(s(r.items[0]!.weightedLow)).toBe("500");
    expect(r.items[1]!.weightedLow!.minus(new D(500).div(F)).abs().lt("0.0001")).toBe(true);
  });

  it("counts only the Primary item in an overlap group and raises issues", () => {
    const b = block([
      { title: "A", impact: "1000", basis: "Cost", probability_low: "0.5", overlap_group: "G1", owner: "Primary" },
      { title: "B", impact: "1000", basis: "Cost", probability_low: "0.5", overlap_group: "g1", owner: "Contributing" },
    ], "500", "x");
    const r = mr.computeReserve(b, F);
    expect(s(r.weightedLow)).toBe("500");
    expect(r.items.map((i) => i.counted)).toEqual([true, false]);
    expect(r.issues).toEqual([]);

    const two = mr.computeReserve(block([
      { title: "A", impact: "1000", basis: "Cost", probability_low: "0.5", overlap_group: "G", owner: "Primary" },
      { title: "B", impact: "1000", basis: "Cost", probability_low: "0.5", overlap_group: "G", owner: "Primary" },
    ]), F);
    expect(two.issues.some((i) => i.includes("2 Primary"))).toBe(true);
    expect(two.status).toBe("RED");

    const none = mr.computeReserve(block([
      { title: "A", impact: "1000", basis: "Cost", probability_low: "0.5", overlap_group: "G", owner: "Contributing" },
      { title: "B", impact: "1000", basis: "Cost", probability_low: "0.5", overlap_group: "G", owner: "Reference Only" },
    ]), F);
    expect(none.weightedLow.isZero()).toBe(true);
    expect(none.issues.some((i) => i.includes("no Primary"))).toBe(true);
  });

  it("does not count an item already provided for in Risk Truth", () => {
    const b = block([{ title: "A", impact: "1000", basis: "Cost", probability_low: "0.5", exposure_ref: "RT05-001" }], "1", "x");
    const r = mr.computeReserve(b, F, [{ ref: "RT05-001", addition: new D(750) }]);
    expect(r.weightedLow.isZero()).toBe(true);
    expect(r.items[0]!.counted).toBe(false);
    expect(r.issues.some((i) => i.includes("Risk Truth"))).toBe(true);
    expect(s(mr.computeReserve(b, F, [{ ref: "RT05-001", addition: new D(0) }]).weightedLow)).toBe("500");
  });

  it("validates input", () => {
    const blank = () => ({ id: "M-x", ...Object.fromEntries(mr.ITEM_FIELDS.map((f) => [f, ""])) }) as mr.ReserveItem;
    for (const [f, bad] of [["impact", "-1"], ["impact", "abc"], ["probability_low", "60"], ["probability_high", "-0.1"], ["basis", "Gross"], ["owner", "Boss"], ["impact_status", "Maybe"], ["prob_status", "SURE"]] as const)
      expect(() => mr.setItemField(blank(), f, bad), `${f}=${bad}`).toThrow(mr.ReserveError);
    expect(() => mr.buildItem("M-x", { title: "x", probability_low: "0.6", probability_high: "0.4" }, [])).toThrow(mr.ReserveError);
    expect(() => mr.buildItem("M-x", {}, [])).toThrow(mr.ReserveError);
    expect(() => mr.setBlockField(mr.newBlock(), "selected", "-5")).toThrow(mr.ReserveError);
    const i = mr.buildItem("M-abcd1", { title: "x", probability_low: "0.6" }, []);
    expect([i.probability_high, i.ref, i.prob_status]).toEqual(["0.6", "MR-01", "AMBER"]);
  });

  it("warns about sell entries and defaults to cost", () => {
    expect(mr.buildItem("M-abcd1", { title: "x" }, []).basis).toBe("Cost");
    const r = mr.computeReserve(block([{ title: "s", impact: "1000", basis: "Sell", probability_low: "0.5" }, { title: "c", impact: "1000", basis: "Cost", probability_low: "0.5" }], "1", "x"), F);
    expect(r.notes.some((n) => n.includes("sell figures"))).toBe(true);
    expect(r.items[0]!.reasons.some((x) => x.includes("moves whenever overhead or margin"))).toBe(true);
    expect(r.items[1]!.reasons).toEqual([]);
  });
});

// NZIQS Quantity Surveyor's Handbook (5th ed.) carpenter example: 45 paid h x $25, KiwiSaver 2%, leave days 20 + 11 + 5,
// levies 6.35%, redundancy 2%, $45 tools per week.
const BOOK = {
  role: "Carpenter", jurisdiction: "NZ", employment_basis: "permanent full time", source_date: "2012", evidence: "market normalised",
  hourly_rate: 25, paid_hours_week: 45, productive_hours_week: 38, kiwisaver_pct: "0.02", annual_leave_days: 20, stat_days: 11,
  sick_days: 5, days_per_week: 5, levy_pct: "0.0635", redundancy_pct: "0.02", weekly_allowance: 45, supervision_pct: "0.05",
};

describe("labour true-cost rate", () => {
  it("reproduces the handbook build-up to the cent", () => {
    const c = lr.computeLabourRate(BOOK);
    const st = Object.fromEntries(c.steps.map((x) => [x.label, x]));
    const r2 = (x: D) => s(cents(x));
    expect(s(c.leavePct.toDecimalPlaces(4))).toBe("0.1602");
    expect(r2(st["Employer KiwiSaver"]!.amount)).toBe("22.5");
    expect(r2(st["Holiday, statutory and sick leave"]!.amount)).toBe("180.23");
    expect(r2(st["Holiday, statutory and sick leave"]!.running)).toBe("1327.73");
    expect(r2(st["Insurance and ACC levies"]!.amount)).toBe("84.31");
    expect(r2(st["Insurance and ACC levies"]!.running)).toBe("1412.04");
    expect(r2(st["Redundancy provision"]!.running)).toBe("1440.28");
    expect(r2(st["Weekly allowances (tools, clothing)"]!.running)).toBe("1485.28");
    expect(s(c.rateRounded)).toBe("41.04");
    expect(c.perPaidHour.lt(c.rate)).toBe(true);
  });

  it("assigns status by the policy", () => {
    expect(lr.computeLabourRate(BOOK).status).toBe("AMBER");
    expect(lr.computeLabourRate({ ...BOOK, evidence: "raw wage" }).status).toBe("RED");
    expect(lr.computeLabourRate({ ...BOOK, evidence: "company actual" }).status).toBe("AMBER");
    expect(lr.computeLabourRate({ ...BOOK, evidence: "company actual", independent_check: true }).status).toBe("GREEN");
    expect(lr.computeLabourRate({ ...BOOK, source_date: "" }).status).toBe("RED");
  });

  it("checks its inputs", () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ role: "" }, /role/], [{ evidence: "guess" }, /Evidence/], [{ hourly_rate: 0 }, /more than zero/], [{ productive_hours_week: 50 }, /exceed paid/],
      [{ kiwisaver_pct: 3 }, /fraction/], [{ levy_pct: "abc" }, /number/], [{ stat_days: -1 }, /negative/],
    ];
    for (const [bad, msg] of cases) expect(() => lr.computeLabourRate({ ...BOOK, ...bad })).toThrow(msg);
  });
});
