/** Ported from QSi Pro engine/tests/test_engine_unit.py (synthetic data, no client files). */
import { describe, expect, it } from "vitest";
import { cents, D } from "@blackline/engine";
import {
  BuildUpError, computeBuildup, computeConsolidated, computeQs, computeTender, computeWeather,
  type BuildUpRow, type CommercialInput, type LibraryRate, type QSItem,
} from "../src/index.js";

const LIB: LibraryRate[] = [
  { code: "PL-EXC", description: "14 t excavator wet hire", unit: "hr", baseRate: 150, operatorIncluded: "Yes" },
  { code: "LAB-OP", description: "Excavator operator", unit: "hr", baseRate: 60 },
  { code: "LAB", description: "Labourer", unit: "hr", baseRate: 38 },
  { code: "MAT", description: "Hardfill", unit: "m3", baseRate: 55 },
];
const QS: QSItem[] = [{ code: "EW01", section: "Earthworks", description: "Strip", unit: "m2", quantity: 800 }];

const row = (o: Partial<BuildUpRow> = {}): BuildUpRow => ({
  qsCode: "EW01", mode: "Time x Count", resourceType: "Plant", resourceCode: "PL-EXC",
  productivityRate: 80, count: 1, utilisation: null, waste: null, verified: "Yes", ...o,
});
const s = (x: { toString(): string } | null) => (x === null ? null : x.toString());

describe("build-up", () => {
  it("Time x Count", () => {
    const r = computeBuildup([row()], QS, LIB)[0]!;
    expect(s(r.calcDurationHrs)).toBe("10");
    expect(s(r.cost)).toBe("1500");
    expect(r.rowId).toBe("EW01-001");
  });
  it("duration override and utilisation", () => {
    const r = computeBuildup([row({ durationOverrideHrs: 20, utilisation: "0.5" })], QS, LIB)[0]!;
    expect(s(r.appliedDurationHrs)).toBe("20");
    expect(s(r.cost)).toBe("1500");
  });
  it("job rate override beats the library", () => {
    const r = computeBuildup([row({ jobRateOverride: 200 })], QS, LIB)[0]!;
    expect(s(r.appliedRate)).toBe("200");
    expect(s(r.cost)).toBe("2000");
    expect(s(r.libraryRate)).toBe("150");
  });
  it("QS Qty x Factor with waste", () => {
    const r = computeBuildup(
      [row({ mode: "QS Qty x Factor", resourceType: "Material", resourceCode: "MAT", productivityRate: null, count: "0.3", waste: "0.1" })],
      QS, LIB,
    )[0]!;
    expect(r.cost.eq(new D(800).times("0.3").times("1.1").times(55))).toBe(true);
  });
  it("Direct Qty and Lump Sum", () => {
    const dq = computeBuildup([row({ mode: "Direct Qty", resourceCode: "MAT", manualQty: 10, waste: "0.05" })], QS, LIB)[0]!;
    expect(dq.cost.eq(new D(10).times("1.05").times(55))).toBe(true);
    const lump = computeBuildup([row({ mode: "Lump Sum / Quote", resourceCode: "MAT", manualQty: 1, jobRateOverride: 5000 })], QS, LIB)[0]!;
    expect(s(lump.cost)).toBe("5000");
  });
  it("blank numbers are zero", () => {
    expect(computeBuildup([row({ count: null })], QS, LIB)[0]!.cost.isZero()).toBe(true);
  });
  it("rejects an unknown mode", () => {
    expect(() => computeBuildup([row({ mode: "Magic" })], QS, LIB)).toThrow(BuildUpError);
  });
  it("numbers row ids per QS code", () => {
    const rs = computeBuildup([row(), row({ resourceCode: "LAB", resourceType: "Labour" })], QS, LIB);
    expect(rs.map((x) => x.rowId)).toEqual(["EW01-001", "EW01-002"]);
  });
  it("derives QA flags", () => {
    const flags = Object.fromEntries(
      computeBuildup([row(), row({ resourceCode: "LAB-OP", resourceType: "Labour" })], QS, LIB).map((r) => [r.rowId, r.qaFlag]),
    );
    expect(flags["EW01-001"]).toBe("OPERATOR DOUBLE-COUNT");
    expect(computeBuildup([row({ resourceCode: "" })], QS, LIB)[0]!.qaFlag).toBe("RESOURCE CODE");
    expect(computeBuildup([row()], QS, [{ code: "PL-EXC", description: "x", unit: "hr", baseRate: 0 }])[0]!.qaFlag).toBe("RATE MISSING");
    expect(computeBuildup([row({ resourceCode: "LAB", resourceType: "Labour", verified: "No" })], QS, LIB)[0]!.qaFlag).toBe("VERIFY");
  });
  it("only labour and plant are weather exposed", () => {
    const rs = computeBuildup(
      [row({ weatherExposed: "Yes" }), row({ mode: "Direct Qty", resourceType: "Material", resourceCode: "MAT", manualQty: 1, weatherExposed: "Yes" })],
      QS, LIB,
    );
    expect(s(rs[0]!.weatherExposedCost)).toBe("1500");
    expect(rs[1]!.weatherExposedCost.isZero()).toBe(true);
  });
  it("QS rate and orphan cost", () => {
    const rs = computeBuildup(
      [row(), row({ qsCode: "ZZ99", mode: "Lump Sum / Quote", resourceCode: "MAT", manualQty: 1, jobRateOverride: 1500 })],
      QS, LIB,
    );
    const res = computeQs(QS, rs);
    expect(s(res.lines[0]!.amount)).toBe("1500");
    expect(s(res.lines[0]!.rate)).toBe("1.875");
    expect(s(res.orphanCost)).toBe("1500");
  });
});

const ci = (ref: string, method: string, o: Partial<CommercialInput> = {}): CommercialInput => ({ ref, name: ref, method, include: "Yes", ...o });

describe("commercial layer", () => {
  it("applies true margin on sell, not markup", () => {
    const t = computeTender(new D(1000), [ci("CA17", "Markup %", { pct: "0.10" }), ci("CA18", "Margin %", { pct: "0.15" })]);
    expect(s(cents(t.overhead))).toBe("100");
    expect(s(cents(t.tenderExclGst))).toBe(s(cents(new D(1100).div("0.85"))));
    expect(s(cents(t.profit.div(t.tenderExclGst)))).toBe("0.15");
  });
  it("honours the include flag and each method", () => {
    const t = computeTender(new D(10000), [
      ci("CA03", "%", { pct: "0.02" }), ci("CA09", "PC Sum", { pcSum: 3000 }), ci("CA10", "Weather Engine", { engineValue: 500 }),
      ci("CA16", "Fixed Amount", { pcSum: 100 }), ci("CA04", "PC Sum", { include: "No", pcSum: 9999 }),
    ]);
    expect(s(t.additions.get("CA03")!)).toBe("200");
    expect(s(t.additions.get("CA09")!)).toBe("3000");
    expect(s(t.additions.get("CA10")!)).toBe("500");
    expect(s(t.additions.get("CA16")!)).toBe("100");
    expect(t.additions.get("CA04")!.isZero()).toBe(true);
    expect(s(t.subtotal)).toBe("13800");
  });
  it("rejects a margin of 100%", () => {
    expect(() => computeTender(new D(1), [ci("CA18", "Margin %", { pct: 1 })])).toThrow(/Margin must be below 100%/);
  });
  it("computes GST and retention", () => {
    const t = computeTender(new D(1000), [ci("CA21", "%", { pct: "0.15" }), ci("CA22", "%", { pct: "0.05" })]);
    expect(s(t.gst)).toBe("150");
    expect(s(t.retentionWithheld)).toBe("50");
    expect(s(t.netAfterRetention)).toBe("950");
  });
});

describe("weather and consolidated package", () => {
  it("scales the tool run to the current exposed pool", () => {
    const rows = computeBuildup([row({ weatherExposed: "Yes" })], QS, LIB); // pool 1500
    const w = computeWeather(rows, { exposedPool: 3000, rainWetGroundCost: 600, criticalPathDelayWd: 2, additionalBilledWeeks: 1 }, { dailyPrelims: 584, weeklyHire: 295 });
    expect(s(w.directProductivity)).toBe("300");
    expect(s(w.criticalPathPrelims)).toBe("1168");
    expect(s(w.billedHire)).toBe("295");
    expect(s(w.allowance)).toBe(s(new D(300).plus(1168).plus(295)));
  });
  it("excludes wind unless included", () => {
    const rows = computeBuildup([row({ weatherExposed: "Yes" })], QS, LIB);
    const tool = { exposedPool: 1500, rainWetGroundCost: 0, criticalPathDelayWd: 0, additionalBilledWeeks: 0, windSensitivityCost: 999 };
    expect(computeWeather(rows, tool, { dailyPrelims: 0, weeklyHire: 0 }).allowance.isZero()).toBe(true);
    expect(s(computeWeather(rows, { ...tool, includeWind: true }, { dailyPrelims: 0, weeklyHire: 0 }).allowance)).toBe("999");
  });
  it("adds overlays once and measures margin on sell", () => {
    const rates = { overheadRate: "0.10", margin: "0.15" };
    const overlays = [{ name: "Coast", amount: 300 }, { name: "Allied", amount: 200 }];
    const c = computeConsolidated(new D(500), overlays, 0, { rates });
    expect(s(c.grossKnownPackage)).toBe("1000");
    const sell = new D(1100).div("0.85");
    expect(s(cents(c.allInTender))).toBe(s(cents(sell)));
    expect(s(cents(c.grossMarginOnSell.times(100)))).toBe(s(cents(sell.minus(1000).div(sell).times(100))));
    const c2 = computeConsolidated(new D(500), overlays, 100, { rates });
    expect(s(cents(c2.allInIfOverlapRemoved))).toBe(s(cents(new D(990).div("0.85"))));
  });
});
