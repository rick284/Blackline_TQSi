import { describe, expect, it } from "vitest";
import { splitIntoPackages, type TenderInputs } from "@blackline/tender/core";
import { addRecord, deleteRecord, effectiveRecords, type Drafts, type ServerRecord } from "../src/lib/draft.js";
import { buildModel } from "../src/lib/model.js";
import { newQsItem, qsDeletion } from "../src/lib/qs.js";

const inputs: TenderInputs = {
  library: [{ code: "SUB", description: "Subcontract", unit: "ea", baseRate: "1" }],
  qs: [
    { code: "EW01", section: "Earthworks", description: "Bulk earthworks", unit: "m3", quantity: "1000" },
    { code: "PV01", section: "Pavements", description: "Basecourse", unit: "m2", quantity: "500" },
  ],
  rows: [
    { qsCode: "EW01", mode: "Lump Sum / Quote", resourceType: "Subcontract", resourceCode: "SUB", manualQty: "1", jobRateOverride: "10000", verified: "Yes", uid: "EW01-001" },
    { qsCode: "EW01", mode: "Lump Sum / Quote", resourceType: "Subcontract", resourceCode: "SUB", manualQty: "1", jobRateOverride: "500", verified: "Yes", uid: "EW01-002" },
    { qsCode: "PV01", mode: "Lump Sum / Quote", resourceType: "Subcontract", resourceCode: "SUB", manualQty: "1", jobRateOverride: "4000", verified: "Yes", uid: "PV01-001" },
  ],
  weatherLinks: { dailyUid: "", hoursPerDay: 8, weeklyUids: [] },
  tool: { exposedPool: 0, rainWetGroundCost: 0, criticalPathDelayWd: 0, additionalBilledWeeks: 0 },
  commercial: [], overlays: [], overlap: "0", reference: null,
};
const server: ServerRecord[] = splitIntoPackages(inputs).flatMap((p, i) => Object.entries(p.records).map(([id, data]) => ({ id, packageId: `pkg-${i}`, data: JSON.parse(JSON.stringify(data)) })));
const total = (d: Drafts) => buildModel(effectiveRecords(server, d)).estimate.qs.totalDirect.toString();

describe("QS items", () => {
  it("makes a new empty item in a section, and refuses a bad or repeated code", () => {
    const r = newQsItem("EW02", "Earthworks", ["EW01", "PV01"], 9);
    expect(r).toMatchObject({ ok: true, recordId: "qs:EW02" });
    expect(r.ok && r.data.body).toEqual({ code: "EW02", section: "Earthworks", description: "", unit: "", quantity: "0" });
    expect(newQsItem("ew01", "Earthworks", ["EW01"], 9)).toMatchObject({ ok: false, error: expect.stringContaining("already") });
    expect(newQsItem("bad code", "Earthworks", [], 9)).toMatchObject({ ok: false });
  });

  it("shows a new item in its section straight away, priced at nothing", () => {
    const made = newQsItem("EW02", "Earthworks", ["EW01", "PV01"], 9);
    if (!made.ok) throw new Error(made.error);
    const pkg = server.find((r) => r.id === "qs:EW01")!.packageId;
    const d = addRecord({}, pkg, made.recordId, made.data);
    const m = buildModel(effectiveRecords(server, d));
    expect(m.qsRows.map((r) => `${r.kind}:${r.kind === "section" ? r.section : r.code}`)).toEqual(["section:Earthworks", "item:EW01", "item:EW02", "section:Pavements", "item:PV01"]);
    expect(m.packageOfQs.get("EW02")).toBe(pkg);
    expect(total(d)).toBe(total({}));
  });

  it("deletes an item together with its build-up rows, so no cost is left behind", () => {
    const m = buildModel(effectiveRecords(server, {}));
    const del = qsDeletion(m, "EW01")!;
    expect(del.rows).toBe(2);
    expect(del.records.map((r) => r.recordId)).toEqual(["qs:EW01", "row:EW01-001", "row:EW01-002"]);
    let d: Drafts = {};
    for (const r of del.records) d = deleteRecord(d, server, r.packageId, r.recordId);
    expect(total(d)).toBe("4000");
    expect(buildModel(effectiveRecords(server, d)).orphanCost.toString()).toBe("0");
    expect(qsDeletion(m, "NOPE")).toBeNull();
  });
});
