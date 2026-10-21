import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cents } from "@blackline/engine";
import { assembleInputs, computeTenderEstimate, loadMasterWorkbook, splitIntoPackages, type TenderInputs } from "../src/index.js";

/** What the database does to a record: through JSON and back. */
const stored = (inputs: TenderInputs) => {
  const records = splitIntoPackages(inputs).flatMap((p) => Object.entries(p.records).map(([id, data]) => ({ id, data })));
  return assembleInputs(JSON.parse(JSON.stringify(records)));
};

const tiny: TenderInputs = {
  library: [{ code: "SUB", description: "Subcontract", unit: "ea", baseRate: "1" }],
  qs: [
    { code: "EW01", section: "Earthworks", description: "Bulk earthworks", unit: "m3", quantity: "1000" },
    { code: "PV01", section: "Pavements", description: "Basecourse", unit: "m2", quantity: "500" },
  ],
  rows: [
    { qsCode: "EW01", mode: "Lump Sum / Quote", resourceType: "Subcontract", resourceCode: "SUB", manualQty: "1", jobRateOverride: "10000", verified: "Yes", uid: "EW01-001" },
    { qsCode: "PV01", mode: "Lump Sum / Quote", resourceType: "Subcontract", resourceCode: "SUB", manualQty: "1", jobRateOverride: "4000", verified: "Yes", uid: "PV01-001" },
    { qsCode: "ZZ99", mode: "Lump Sum / Quote", resourceType: "Subcontract", resourceCode: "SUB", manualQty: "1", jobRateOverride: "50", verified: "Yes", uid: "ZZ99-001" },
  ],
  weatherLinks: { dailyUid: "", hoursPerDay: 8, weeklyUids: [] },
  tool: { exposedPool: 0, rainWetGroundCost: 0, criticalPathDelayWd: 0, additionalBilledWeeks: 0 },
  commercial: [
    { ref: "CA03", name: "Allowance", method: "%", include: "Yes", pct: "0.02", pcSum: "0" },
    { ref: "CA17", name: "Overhead", method: "Markup %", include: "Yes", pct: "0.10", pcSum: "0" },
    { ref: "CA18", name: "Profit", method: "Margin %", include: "Yes", pct: "0.15", pcSum: "0" },
  ],
  overlays: [{ name: "Concrete sub", amount: "5000" }],
  overlap: "0",
  reference: null,
};

describe("packaging", () => {
  it("splits into one package per QS section plus the shared packages", () => {
    const keys = splitIntoPackages(tiny).map((p) => p.key);
    expect(keys.slice(0, 3)).toEqual(["qs:Earthworks", "qs:Pavements", "qs:Unassigned rows"]);
    for (const k of ["library", "commercial", "subcontracts", "risk", "narrative", "programme", "settings"]) expect(keys).toContain(k);
    const ew = splitIntoPackages(tiny)[0]!;
    expect(Object.keys(ew.records)).toEqual(["qs:EW01", "row:EW01-001"]);
  });

  it("puts rows with no QS item in an Unassigned package so their cost is not lost", () => {
    const un = splitIntoPackages(tiny).find((p) => p.key === "qs:Unassigned rows")!;
    expect(Object.keys(un.records)).toEqual(["row:ZZ99-001"]);
  });

  it("round-trips through JSON to the same estimate", () => {
    const a = computeTenderEstimate(tiny);
    const b = computeTenderEstimate(stored(tiny));
    expect(b.tender.tenderExclGst.toString()).toBe(a.tender.tenderExclGst.toString());
    expect(cents(b.consolidated.allInTender).toString()).toBe(cents(a.consolidated.allInTender).toString());
    expect(b.qs.orphanCost.toString()).toBe("50");
    expect(b.qs.totalDirect.toString()).toBe("14000");
  });

  it("keeps list order, whatever order records come back in", () => {
    const records = splitIntoPackages(tiny).flatMap((p) => Object.entries(p.records).map(([id, data]) => ({ id, data }))).reverse();
    const a = assembleInputs(records);
    expect(a.qs.map((q) => q.code)).toEqual(["EW01", "PV01"]);
    expect(a.rows.map((r) => r.uid)).toEqual(["EW01-001", "PV01-001", "ZZ99-001"]);
  });
});

const FILE = new URL("../../../private/Rev34E.xlsx", import.meta.url);
describe.skipIf(!existsSync(FILE))("packaging the Hobsonville workbook", () => {
  it("stores and rebuilds the whole job without changing a cent", async () => {
    const wb = await loadMasterWorkbook(readFileSync(FILE));
    const before = computeTenderEstimate(wb);
    const after = computeTenderEstimate(stored(wb));
    expect(cents(after.consolidated.allInTender).toString()).toBe("1226916.81");
    expect(after.consolidated.allInTender.toString()).toBe(before.consolidated.allInTender.toString());
    expect(after.reconciled).toBe(true);
    expect(after.schedule.reconciles).toBe(true);
    const pkgs = splitIntoPackages(wb);
    expect(pkgs.filter((p) => p.kind === "qs-section").length).toBe(8);
  });
});
