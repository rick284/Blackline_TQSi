import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadMasterWorkbook, splitIntoPackages, type TenderInputs } from "@blackline/tender";
import { addRecord, editRecord, effectiveRecords, type ServerRecord } from "../src/lib/draft.js";
import { buildModel, nextUid } from "../src/lib/model.js";

const tiny: TenderInputs = {
  library: [{ code: "SUB", description: "Subcontract", unit: "ea", baseRate: "1" }],
  qs: [
    { code: "EW01", section: "Earthworks", description: "Bulk earthworks", unit: "m3", quantity: "1000" },
    { code: "PV01", section: "Pavements", description: "Basecourse", unit: "m2", quantity: "500" },
  ],
  rows: [
    { qsCode: "EW01", mode: "Lump Sum / Quote", resourceType: "Subcontract", resourceCode: "SUB", manualQty: "1", jobRateOverride: "10000", verified: "Yes", uid: "EW01-001" },
    { qsCode: "PV01", mode: "Lump Sum / Quote", resourceType: "Subcontract", resourceCode: "SUB", manualQty: "1", jobRateOverride: "4000", verified: "Yes", uid: "PV01-001" },
  ],
  weatherLinks: { dailyUid: "", hoursPerDay: 8, weeklyUids: [] },
  tool: { exposedPool: 0, rainWetGroundCost: 0, criticalPathDelayWd: 0, additionalBilledWeeks: 0 },
  commercial: [
    { ref: "CA17", name: "Overhead", method: "Markup %", include: "Yes", pct: "0.10", pcSum: "0" },
    { ref: "CA18", name: "Profit", method: "Margin %", include: "Yes", pct: "0.15", pcSum: "0" },
  ],
  overlays: [],
  overlap: "0",
  reference: null,
};

/** What the server hands the browser: records tagged with their package ids. */
const asServer = (inputs: TenderInputs): ServerRecord[] =>
  splitIntoPackages(inputs).flatMap((p, i) => Object.entries(p.records).map(([id, data]) => ({ id, packageId: `pkg-${i}-${p.key}`, data: JSON.parse(JSON.stringify(data)) })));

describe("workbench model", () => {
  it("lists sections and items with their cost, and a package for each item", () => {
    const m = buildModel(asServer(tiny));
    expect(m.qsRows.map((r) => `${r.kind}:${r.kind === "section" ? r.section : r.code}`)).toEqual(["section:Earthworks", "item:EW01", "section:Pavements", "item:PV01"]);
    const ew = m.qsRows.find((r) => r.code === "EW01")!;
    expect(ew.amount.toString()).toBe("10000");
    expect(ew.rows).toBe(1);
    expect(ew.packageId).toBe("pkg-0-qs:Earthworks");
    expect(m.qsRows.find((r) => r.section === "Earthworks" && r.kind === "section")!.amount.toString()).toBe("10000");
    expect(m.buildups.get("EW01")![0]!.rowId).toBe("EW01-001");
  });

  it("shows a row's own description over the library's, and the library's again once it is cleared", () => {
    const server = asServer(tiny);
    const own = editRecord({}, server, "pkg-0-qs:Earthworks", "row:EW01-001", (b) => ({ ...b, description: "  Strip and stockpile topsoil " }));
    expect(buildModel(effectiveRecords(server, {})).buildups.get("EW01")![0]!.resource).toBe("Subcontract");
    expect(buildModel(effectiveRecords(server, own)).buildups.get("EW01")![0]!.resource).toBe("Strip and stockpile topsoil");
    const cleared = editRecord(own, server, "pkg-0-qs:Earthworks", "row:EW01-001", (b) => ({ ...b, description: "" }));
    expect(buildModel(effectiveRecords(server, cleared)).buildups.get("EW01")![0]!.resource).toBe("Subcontract");
  });

  it("recalculates the whole job from one edited cell, and drafts do not touch the server records", () => {
    const server = asServer(tiny);
    const before = buildModel(effectiveRecords(server, {}));
    const drafts = editRecord({}, server, "pkg-0-qs:Earthworks", "row:EW01-001", (b) => ({ ...b, jobRateOverride: "12000" }));
    const after = buildModel(effectiveRecords(server, drafts));
    expect(after.qsRows.find((r) => r.code === "EW01")!.amount.toString()).toBe("12000");
    expect(Number(after.estimate.tender.tenderExclGst) - Number(before.estimate.tender.tenderExclGst)).toBeCloseTo((2000 * 1.1) / 0.85, 6);
    expect(buildModel(effectiveRecords(server, {})).qsRows.find((r) => r.code === "EW01")!.amount.toString()).toBe("10000");
  });

  it("shows a new row at once, and flags rows that need attention", () => {
    const server = asServer(tiny);
    const drafts = addRecord({}, "pkg-0-qs:Earthworks", "row:EW01-002", {
      kind: "row", seq: 5, body: { qsCode: "EW01", mode: "Lump Sum / Quote", resourceType: "Subcontract", resourceCode: "SUB", manualQty: "1", jobRateOverride: null, verified: "No", uid: "EW01-002" },
    });
    const m = buildModel(effectiveRecords(server, drafts));
    const rows = m.buildups.get("EW01")!;
    expect(rows.map((r) => r.rowId)).toEqual(["EW01-001", "EW01-002"]);
    expect(m.qsRows.find((r) => r.code === "EW01")!.flags).toBe(1); // the new row is unverified
    expect(rows[1]!.packageId).toBe("pkg-0-qs:Earthworks");
  });

  it("finds the next free row id", () => {
    expect(nextUid("EW01", ["EW01-001", "EW01-003"])).toBe("EW01-002");
    expect(nextUid("EW01", [])).toBe("EW01-001");
  });
});

describe("rate library model", () => {
  const withLibrary: TenderInputs = {
    ...tiny,
    library: [
      { code: "LAB", category: "Labour", description: "Labourer", unit: "hr", baseRate: "50", operatorIncluded: "No", fuelIncluded: "", source: "Quote 1" },
      { code: "SPARE", category: "Plant", description: "Unused plant", unit: "hr", baseRate: "100" },
    ],
    qs: [{ code: "EW01", section: "Earthworks", description: "Strip", unit: "m2", quantity: "100" }],
    rows: [
      { qsCode: "EW01", mode: "Time x Count", resourceType: "Labour", resourceCode: "LAB", productivityRate: "10", count: "2", verified: "Yes", uid: "EW01-001" },
      { qsCode: "EW01", mode: "Direct Qty", resourceType: "Labour", resourceCode: "LAB", manualQty: "4", verified: "Yes", uid: "EW01-002" },
    ],
    overlays: [],
  };

  it("lists each rate with the rows that use it and the cost they carry", () => {
    const m = buildModel(asServer(withLibrary));
    const lab = m.library.find((r) => r.code === "LAB")!;
    expect([lab.usedBy, lab.cost.toString()]).toEqual([2, "1200"]); // 10 hours x 2 x $50, plus 4 x $50
  });
});
describe("rate library edits", () => {
  const lib: TenderInputs = {
    ...tiny,
    library: [{ code: "LAB", category: "Labour", description: "Labourer", unit: "hr", baseRate: "50" }, { code: "SPARE", category: "Plant", description: "Unused", unit: "hr", baseRate: "100" }],
    qs: [{ code: "EW01", section: "Earthworks", description: "Strip", unit: "m2", quantity: "100" }],
    rows: [{ qsCode: "EW01", mode: "Direct Qty", resourceType: "Labour", resourceCode: "LAB", manualQty: "4", verified: "Yes", uid: "EW01-001" }],
    overlays: [],
  };

  it("reprices every row that uses a rate when the rate changes, and an unused rate carries nothing", () => {
    const server = asServer(lib);
    const libPkg = server.find((r) => r.id === "library:LAB")!.packageId;
    const before = buildModel(effectiveRecords(server, {}));
    expect(before.libraryPackageId).toBe(libPkg);
    const spare = before.library.find((r) => r.code === "SPARE")!;
    expect([spare.usedBy, spare.cost.toString()]).toEqual([0, "0"]);
    const drafts = editRecord({}, server, libPkg, "library:LAB", (b) => ({ ...b, baseRate: "60" }));
    const after = buildModel(effectiveRecords(server, drafts));
    expect(after.library.find((r) => r.code === "LAB")!.cost.toString()).toBe("240"); // 4 x $60, was 4 x $50
    expect(before.estimate.qs.totalDirect.toString()).toBe("200");
    expect(after.estimate.qs.totalDirect.toString()).toBe("240");
  });

  it("shows a newly added rate straight away, in the library package", () => {
    const server = asServer(lib);
    const libPkg = server.find((r) => r.id === "library:LAB")!.packageId;
    const drafts = addRecord({}, libPkg, "library:LAB-CARP", { kind: "library", seq: 9, body: { code: "LAB-CARP", description: "", unit: "", baseRate: "0", category: "", operatorIncluded: "", fuelIncluded: "", source: "" } });
    const m = buildModel(effectiveRecords(server, drafts));
    const carp = m.library.find((r) => r.code === "LAB-CARP")!;
    expect([carp.packageId, carp.usedBy]).toEqual([libPkg, 0]);
  });
});
const FILE = new URL("../../../private/Rev34E.xlsx", import.meta.url);
describe.skipIf(!existsSync(FILE))("workbench model on Hobsonville", () => {
  it("shows the workbook's totals, and one edit moves the price by the engine's amount", async () => {
    const wb = await loadMasterWorkbook(readFileSync(FILE));
    const server: ServerRecord[] = splitIntoPackages(wb).flatMap((p, i) => Object.entries(p.records).map(([id, data]) => ({ id, packageId: `pkg-${i}`, data: JSON.parse(JSON.stringify(data)) })));
    const m = buildModel(server);
    expect(m.qsRows.filter((r) => r.kind === "item").length).toBe(30);
    expect(m.estimate.consolidated.allInTender.toDecimalPlaces(2).toString()).toBe("1226916.81");
    expect(m.orphanCost.isZero()).toBe(true);
  });
});
