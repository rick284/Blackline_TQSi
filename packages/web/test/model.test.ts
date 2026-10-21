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
