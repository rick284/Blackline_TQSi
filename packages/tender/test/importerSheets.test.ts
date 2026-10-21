import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { assembleInputs, loadMasterWorkbook, scope, splitIntoPackages } from "../src/index.js";
import { durationDays } from "../src/importers/masterWorkbook.js";

type Rows = (string | number | null)[][];

/** A workbook with the four sheets every import needs (one QS code, EW01, among them) plus whatever else the test adds. */
async function workbook(extra: (wb: ExcelJS.Workbook) => void): Promise<Awaited<ReturnType<typeof loadMasterWorkbook>>> {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet("Resource Rate Library");
  const qs = wb.addWorksheet("QS Takeoff");
  qs.getRow(3).values = ["Earthworks", "EW01", "Strip", "m2", 100];
  qs.getRow(4).values = ["Earthworks", "EW02", "Fill", "m3", 50];
  wb.addWorksheet("Resource Build-Up");
  wb.addWorksheet("Commercial Inputs");
  extra(wb);
  return loadMasterWorkbook(new Uint8Array(await wb.xlsx.writeBuffer()));
}
const sheet = (wb: ExcelJS.Workbook, name: string, header: string[], rows: Rows) => {
  const ws = wb.addWorksheet(name);
  ws.addRow(header);
  rows.forEach((r) => ws.addRow(r));
};

describe("a build-up row the engine could not calculate", () => {
  it("stops the import and names the row, rather than loading a job that can't be calculated", async () => {
    const bad = workbook((b) => { b.getWorksheet("Resource Build-Up")!.getRow(7).values = ["", "EW01", "", "", "", "", "", "", "", "", "", "", "", "Time x Count / typo"]; });
    await expect(bad).rejects.toThrow(/Resource Build-Up row 7 \(EW01\): the calculation is "Time x Count \/ typo", which isn't one of: Time x Count, QS Qty x Factor, Direct Qty, Lump Sum \/ Quote/);
    const none = workbook((b) => { b.getWorksheet("Resource Build-Up")!.getRow(7).values = ["", "EW01"]; });
    await expect(none).rejects.toThrow('the calculation is ""');
  });
});

describe("the Scope Coverage sheet", () => {
  const HEAD = ["Scope ID", "Group", "Requirement", "Detail", "Source", "Owner", "Treatment", "Cost refs (QS codes / CA lines)", "Register refs", "Quote refs", "Basis", "Action"];

  it("reads one scope item per requirement, numbering those with no ID and matching a header that carries a hint", async () => {
    const wb = await workbook((b) => sheet(b, "Scope Coverage", HEAD, [
      [null, "Permanent works", "Site strip and earthworks", "", "", "OWN WORKS", "PRICED", "EW01, EW02", "", "", "Measured from sheet C1", ""],
      ["SC-010", "Interface with others", "Building structure", "", "Tender documents", "OTHERS", "EXCLUDED", "", "ex-01", "", "", ""],
      [null, "Permanent works", "Retaining height", "", "", "TBC", "UNRESOLVED", "", "RFI-01", "", "", "Ask the engineer"],
    ]));
    expect(wb.scope.map((x) => [x.ref, x.title, x.owner, x.treatment])).toEqual([
      ["SC-001", "Site strip and earthworks", "OWN WORKS", "PRICED"], ["SC-010", "Building structure", "OTHERS", "EXCLUDED"], ["SC-011", "Retaining height", "TBC", "UNRESOLVED"],
    ]);
    expect(wb.scope[0]).toMatchObject({ cost_refs: "EW01, EW02", group: "Permanent works", basis: "Measured from sheet C1" });
    expect(wb.scope[1]).toMatchObject({ register_refs: "EX-01", source: "Tender documents" }); // references are upper-cased and tidied
    expect(wb.notes.some((n) => n.startsWith("3 scope requirements read from the Scope Coverage sheet"))).toBe(true);
  });

  it("keeps a row whose group, owner or treatment isn't one of ours, with those blank, instead of dropping it", async () => {
    const wb = await workbook((b) => sheet(b, "Scope Coverage", HEAD, [
      [null, "Mystery group", "Haul road", "", "", "Whoever", "MAYBE", "", "", "", "", ""],
      [null, "Permanent works", "Kerbs", "", "", "OWN WORKS", "PRICED", "EW01", "", "", "", ""],
      [null, "Permanent works", "", "a row with no requirement", "", "", "", "", "", "", "", ""], // blank requirement: nothing to record
    ]));
    expect(wb.scope.map((x) => [x.title, x.group, x.owner, x.treatment])).toEqual([["Haul road", "", "", ""], ["Kerbs", "Permanent works", "OWN WORKS", "PRICED"]]);
    expect(wb.notes.join(" ")).toContain("1 had a group, owner or treatment that isn't one of ours");
  });

  it("is checked by the platform afterwards: the item with no owner or treatment is MISSING, the backed-up one is complete", async () => {
    const wb = await workbook((b) => sheet(b, "Scope Coverage", HEAD, [
      [null, "Mystery group", "Haul road", "", "", "Whoever", "MAYBE", "", "", "", "", ""],
      [null, "Permanent works", "Strip", "", "", "OWN WORKS", "PRICED", "EW01", "", "", "", ""],
    ]));
    const r = scope.computeScope(wb.scope, { EW01: 1000 }, [], new Set());
    expect(r.items.map((i) => [i.title, i.status])).toEqual([["Haul road", "MISSING"], ["Strip", "COMPLETE"]]);
  });

  it("without the sheet, or without a Requirement column, there is simply no scope yet", async () => {
    expect((await workbook(() => undefined)).scope).toEqual([]);
    const odd = await workbook((b) => sheet(b, "Scope Coverage", ["Thing", "Who"], [["x", "y"]]));
    expect(odd.scope).toEqual([]);
    expect(odd.notes.some((n) => n.includes("needs a 'Requirement' column"))).toBe(true);
  });

  it("is stored as records, so a job started from the workbook has its scope", async () => {
    const wb = await workbook((b) => sheet(b, "Scope Coverage", HEAD, [[null, "Permanent works", "Strip", "", "", "OWN WORKS", "PRICED", "EW01", "", "", "", ""]]));
    const records = splitIntoPackages(wb).flatMap((p) => Object.entries(p.records).map(([id, data]) => ({ id, data })));
    expect(records.some((r) => r.id === "scope:C-wb0001")).toBe(true);
    expect(assembleInputs(records).scope!.map((x) => x.title)).toEqual(["Strip"]);
  });
});

describe("the MS Project Import fallback", () => {
  const HEAD = ["ID", "Outline Level", "WBS", "Task Name", "Duration", "Predecessors", "Category", "Notes"];
  const ms = (rows: Rows) => (b: ExcelJS.Workbook) => sheet(b, "MS Project Import", HEAD, rows);

  it("reads the working durations in days, weeks and hours, rounding up", () => {
    expect(["55 days", "3d", "2 wks", "1 week", "16 hrs", "4", "3.2d", "2.5 h", "soon", ""].map(durationDays)).toEqual([55, 3, 10, 5, 2, 4, 4, 1, null, null]);
  });

  it("builds the programme from the table: the WBS is the QS code, predecessors are task IDs, and prelims are hammocks", async () => {
    const wb = await workbook(ms([
      [1, 1, "PG01", "Preliminaries", "55 days", "", "Preliminaries", "Site setup to handover"],
      [2, 2, "EW01", "Strip topsoil", "2 days", "1", "", ""],
      [3, 2, "EW02", "Bulk fill", "1 wk", "2FS; 1SS+2d", "", ""],
      [4, 2, "", "A row with no code", "3 days", "3", "", ""], // no code: left out
      [5, 2, "ZZ99", "Unknown to the takeoff", "16 hrs", "3;99;5", "", ""], // 99 is no task, 5 is itself
    ]));
    const p = wb.programme!;
    expect(p.tasks.map((t) => [t.code, t.qs_code, t.override_days, t.predecessors, t.hammock])).toEqual([
      ["PG01", "", "55", [], true], ["EW01", "EW01", "2", ["PG01"], false], ["EW02", "EW02", "5", ["EW01", "PG01"], false], ["ZZ99", "", "2", ["EW02"], false],
    ]);
    expect(p.tasks[0]).toMatchObject({ basis: "From MS Project Import sheet", note: "Site setup to handover", id: "P-00001" });
    expect(p).toMatchObject({ hours_per_day: 8, days_per_week: 5 });
    expect(wb.notes.some((n) => n.startsWith("The programme was built from the MS Project Import sheet (4 tasks"))).toBe(true);
  });

  it("is used only when there is no Programme Export, and not at all without its columns or any usable row", async () => {
    const withExport = await workbook((b) => {
      const pe = b.addWorksheet("Programme Export");
      pe.getRow(7).values = ["", "", "Earthworks", "EW01", "Strip", "", "", "", "", "", "", 3, "", "", "", "", "", "", "", "", "", "", "", ""];
      ms([[1, 1, "EW01", "From the import table", "9 days", "", "", ""]])(b);
    });
    expect(withExport.programme!.tasks.map((t) => t.name)).toEqual(["Strip"]); // the Programme Export wins
    expect(withExport.notes.some((n) => n.includes("MS Project Import"))).toBe(false);
    expect((await workbook((b) => sheet(b, "MS Project Import", ["ID", "Name"], [[1, "x"]]))).programme).toBeNull();
    expect((await workbook(ms([[1, 1, "", "No code anywhere", "2 days", "", "", ""]]))).programme).toBeNull();
    expect((await workbook(() => undefined)).programme).toBeNull();
  });
});
