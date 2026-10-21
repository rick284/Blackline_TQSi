import { describe, expect, it } from "vitest";
import { assembleInputs, computeTenderEstimate, type TenderInputs } from "../src/index.js";
import * as T from "../src/template.js";

describe("the blank tender", () => {
  const parts = T.blankTender({ project: "New school", overheadPct: "10", profitPct: "15" });
  const ca = (inputs: TenderInputs) => Object.fromEntries(inputs.commercial.map((c) => [c.ref, c]));

  it("has the standard commercial stack, with only risk, overhead and profit switched on", () => {
    const inputs = assembleInputs(parts.flatMap((p) => Object.entries(p.records).map(([id, data]) => ({ id, data }))));
    expect(inputs.commercial.map((c) => c.ref)).toEqual(Array.from({ length: 24 }, (_, i) => `CA${String(i + 1).padStart(2, "0")}`));
    expect(inputs.commercial.filter((c) => c.include === "Yes").map((c) => c.ref)).toEqual(["CA01", "CA02", "CA17", "CA18"]);
    expect(ca(inputs).CA17).toMatchObject({ method: "Markup %", pct: "0.1" });
    expect(ca(inputs).CA18).toMatchObject({ method: "Margin %", pct: "0.15" });
    expect(ca(inputs).CA10).toMatchObject({ method: "Weather Engine", include: "No" });
    expect(inputs.meta).toMatchObject({ project: "New school" });
  });

  it("is the packages every tender is built from, with no QS sections and nothing priced", () => {
    expect(parts.map((p) => p.key)).toEqual(["library", "commercial", "subcontracts", "risk", "narrative", "programme", "settings"]);
    expect(parts.some((p) => p.kind === "qs-section")).toBe(false);
    const e = computeTenderEstimate(assembleInputs(parts.flatMap((p) => Object.entries(p.records).map(([id, data]) => ({ id, data })))));
    expect([e.qs.totalDirect.toString(), e.consolidated.allInTender.toString(), e.schedule.reconciles]).toEqual(["0", "0", true]);
  });

  it("prices with the overhead and profit the person chose, as soon as something is in it", () => {
    const base = T.blankInputs({ overheadPct: "10", profitPct: "15" });
    const priced: TenderInputs = {
      ...base,
      library: [{ code: "SUB", description: "Subcontract", unit: "ea", baseRate: "1" }],
      qs: [{ code: "EW01", section: "Earthworks", description: "Strip", unit: "m2", quantity: "100" }],
      rows: [{ qsCode: "EW01", mode: "Lump Sum / Quote", resourceType: "Subcontract", resourceCode: "SUB", manualQty: "1", jobRateOverride: "1000", verified: "Yes", uid: "EW01-001" }],
    };
    const e = computeTenderEstimate(priced);
    // 1,000 + 10% overhead = 1,100; profit 15% of the price: 1,100 / 0.85
    expect(Number(e.consolidated.allInTender.toString())).toBeCloseTo(1100 / 0.85, 2);
    const none = computeTenderEstimate({ ...priced, commercial: T.standardCommercial("0", "0") });
    expect(Number(none.consolidated.allInTender.toString())).toBeCloseTo(1000, 2);
  });

  it("takes percentages as typed, and refuses nonsense or a margin that would stop the job calculating", () => {
    expect(T.fractionOf("12.5%", "Overhead", 100)).toBe("0.125");
    expect(T.fractionOf("0", "Profit", 60)).toBe("0");
    expect(() => T.fractionOf("ten", "Overhead", 100)).toThrow("percentage");
    expect(() => T.fractionOf("100", "Profit margin", 60)).toThrow("can't be more than 60%");
    expect(() => T.blankTender({ overheadPct: "10", profitPct: "70" })).toThrow("Profit margin");
  });
});

describe("a new QS section", () => {
  it("is a package of its own, named tidily and unique without regard to capitals", () => {
    const p = T.sectionPackage("  Pipes   and drainage ", ["Earthworks"]);
    expect([p.key, p.name, p.kind, Object.keys(p.records)]).toEqual(["qs:Pipes and drainage", "Pipes and drainage", "qs-section", []]);
    expect(() => T.sectionPackage("earthworks", ["Earthworks"])).toThrow("already a section");
    expect(() => T.sectionPackage("  ", [])).toThrow("Name the section");
    expect(() => T.sectionPackage("x".repeat(81), [])).toThrow("too long");
    expect(() => T.sectionPackage("Unassigned rows", [])).toThrow("rows that have no QS item");
  });
});
