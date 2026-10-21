import { existsSync, readFileSync } from "node:fs";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { computeTenderEstimate, estimateWorkbook, letterDoc, letterPdf, loadMasterWorkbook, type TenderInputs } from "../src/index.js";
import { defaultLetter } from "../src/submission.js";

const inputs: TenderInputs = {
  library: [{ code: "SUB", description: "Subcontract", unit: "ea", baseRate: "1" }],
  qs: [
    { code: "EW01", section: "Earthworks", description: "Bulk earthworks, strip & stockpile", unit: "m3", quantity: "1000" },
    { code: "PV01", section: "Pavements", description: "Basecourse", unit: "m2", quantity: "500" },
  ],
  rows: [
    { qsCode: "EW01", mode: "Lump Sum / Quote", resourceType: "Subcontract", resourceCode: "SUB", manualQty: "1", jobRateOverride: "10000.333", verified: "Yes", uid: "EW01-001", task: "Strip" },
    { qsCode: "PV01", mode: "Lump Sum / Quote", resourceType: "Subcontract", resourceCode: "SUB", manualQty: "1", jobRateOverride: "4000", verified: "Yes", uid: "PV01-001" },
  ],
  weatherLinks: { dailyUid: "", hoursPerDay: 8, weeklyUids: [] },
  tool: { exposedPool: 0, rainWetGroundCost: 0, criticalPathDelayWd: 0, additionalBilledWeeks: 0 },
  commercial: [
    { ref: "CA05", name: "Site establishment", method: "PC Sum", include: "Yes", pct: "0", pcSum: "2500" },
    { ref: "CA17", name: "Overhead", method: "Markup %", include: "Yes", pct: "0.10", pcSum: "0" },
    { ref: "CA18", name: "Profit", method: "Margin %", include: "Yes", pct: "0.15", pcSum: "0" },
  ],
  overlays: [{ name: "Concrete sub", amount: "5000" }],
  overlap: "0",
  reference: null,
  quotes: [{ id: "Q-01", ref: "Q-01", package: "Concrete sub", supplier: "Coast", estimate_ref: "", qty: "", unit: "", amount: "5000", scope: "", documents: "", status: "Received", action: "", notes: "", treatment: "", verification: "", source: "", quote_date: "", valid_until: "2026-12-01" }],
};

async function read(buf: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as never);
  return wb;
}
const sheetRows = (wb: ExcelJS.Workbook, name: string) => {
  const rows: unknown[][] = [];
  wb.getWorksheet(name)!.eachRow((r) => rows.push((r.values as unknown[]).slice(1)));
  return rows;
};

describe("the estimate as an Excel workbook", () => {
  const e = computeTenderEstimate(inputs);
  it("has a sheet for each part of the tender, and a Procurement sheet only once procurement has been started", async () => {
    const wb = await read(await estimateWorkbook(e, inputs, { title: "Hobsonville", subtitle: "Rev A" }));
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Summary", "QS Takeoff", "Build-up", "Commercial", "Price schedule", "Subcontracts", "Scope", "Quotes"]);
  });

  it("carries the engine's figures to the cent, not recalculated: takeoff, commercial lines and the all-in", async () => {
    const wb = await read(await estimateWorkbook(e, inputs, { title: "Job", subtitle: "Working copy" }));
    const summary = Object.fromEntries(sheetRows(wb, "Summary").filter((r) => typeof r[1] === "number").map((r) => [r[0] as string, r[1] as number]));
    expect(summary["Base direct estimate"]).toBeCloseTo(14000.33, 2);
    expect(summary["Working all-in tender excl. GST"]).toBeCloseTo(Number(e.consolidated.allInTender.toFixed(2)), 2);
    expect(summary["Subcontract packages"]).toBe(5000);
    const qs = sheetRows(wb, "QS Takeoff");
    expect(qs[0]).toEqual(["Code", "Section", "Description", "Unit", "Quantity", "Rate", "Amount"]);
    expect(qs[1]).toEqual(["EW01", "Earthworks", "Bulk earthworks, strip & stockpile", "m3", 1000, 10, 10000.33]);
    expect(qs[qs.length - 1]![6]).toBe(14000.33);
    const ca = sheetRows(wb, "Commercial").find((r) => r[0] === "CA05")!;
    expect([ca[3], ca[7]]).toEqual(["Yes", 2500]);
    const bu = sheetRows(wb, "Build-up")[1]!;
    expect([bu[1], bu[2], bu[4], bu[9]]).toEqual(["EW01", "Strip", "SUB", 10000.33]);
  });

  it("writes the price schedule in the client's order, ending in a total that is the all-in", async () => {
    const wb = await read(await estimateWorkbook(e, inputs, { title: "Job", subtitle: "x" }));
    const rows = sheetRows(wb, "Price schedule");
    const last = rows[rows.length - 1]!;
    expect(last[1]).toBe("Total tender price excluding GST");
    expect(last[2]).toBeCloseTo(Number(e.schedule.total.toFixed(2)), 2);
    expect(rows.slice(1, -1).some((r) => r[1] === "Overhead and margin")).toBe(true);
  });

  it("is frozen at the header row and formatted as money, so it opens ready to read", async () => {
    const wb = await read(await estimateWorkbook(e, inputs, { title: "Job", subtitle: "x" }));
    const ws = wb.getWorksheet("QS Takeoff")!;
    expect(ws.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
    expect(ws.getCell("G2").numFmt).toContain("#,##0.00");
  });

  const golden = existsSync(new URL("../../../private/Rev34E.xlsx", import.meta.url));
  it.skipIf(!golden)("reproduces Hobsonville's all-in of 1,226,916.81 and every takeoff line in the file", async () => {
    const wbIn: TenderInputs = await loadMasterWorkbook(readFileSync(new URL("../../../private/Rev34E.xlsx", import.meta.url)));
    const est = computeTenderEstimate(wbIn);
    const wb = await read(await estimateWorkbook(est, wbIn, { title: "329 Hobsonville Road", subtitle: "Rev34E" }));
    const all = sheetRows(wb, "Summary").find((r) => r[0] === "Working all-in tender excl. GST")!;
    expect(all[1]).toBe(1226916.81);
    expect(sheetRows(wb, "QS Takeoff").length).toBe(est.qs.lines.length + 2);
    expect(sheetRows(wb, "Build-up").length).toBe(wbIn.rows.filter((r) => r.qsCode).length + 1);
  });
});

describe("the tender letter as a PDF", () => {
  const schedule = { groups: [{ name: "WORKS", code: "", total: "1234.5", lines: [{ ref: "01", trade: "Earthworks", kind: "work", amount: "1000" }, { ref: "02", trade: "Margin", kind: "margin", amount: "234.5" }] }], total: "1234.5", reconciles: true };
  const letter = { ...defaultLetter({ name: "Roads", client: "Council" }), signatory: "Rick, Director" };
  const q = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `Q${i}`, kind: "custom", ref: "", text: `Qualification ${i + 1}: price is based on the information supplied at tender, and excludes rock excavation, dewatering and any contaminated material unless stated.`, include: true }));
  const pages = (b: Buffer) => (b.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length;

  it("is a real PDF of one page for a short letter", async () => {
    const doc = letterDoc({ company: "Demo Civil", today: new Date(2026, 10, 12), letter, qualifications: q(2), alternatives: [{ id: "A1", title: "Concrete paths", description: "Instead of AP40", amount: "-3000", include: true }], schedule });
    const b = await letterPdf(doc, { compress: false });
    expect(b.subarray(0, 5).toString()).toBe("%PDF-");
    expect(b.subarray(-6).toString()).toContain("%%EOF");
    expect(pages(b)).toBe(1);
    expect(b.toString("latin1")).toContain("(Tender for Roads)"); // the subject is stored as the document's title
    expect(b.toString("latin1")).toContain("(Demo Civil)"); // and the company as its author
  });

  it("flows onto more pages when there is more to say, repeating nothing it shouldn't", async () => {
    const lines = Array.from({ length: 60 }, (_, i) => ({ ref: String(i + 1).padStart(2, "0"), trade: `Trade line number ${i + 1} with a longer description to wrap`, kind: "work", amount: String(1000 + i) }));
    const doc = letterDoc({ company: "Demo Civil", today: new Date(2026, 10, 12), letter, qualifications: q(40), alternatives: [], schedule: { ...schedule, groups: [{ name: "WORKS", code: "", total: "100000", lines }] } });
    const b = await letterPdf(doc, { compress: false });
    expect(pages(b)).toBeGreaterThanOrEqual(3);
    expect(b.byteLength).toBeGreaterThan(5000);
  });
});
