/**
 * The estimate as an Excel workbook: what a tender looked like, in a file anyone can open, check and send on. It is written from the estimate the engine
 * already calculated (nothing is worked out here), either for the job as it stands or for an issued revision, which is exactly what the client was sent.
 * Money goes in as cents-rounded numbers formatted to two places; a workbook cell is a double, so this file is for reading and checking, and the
 * platform's own figures remain the exact ones.
 *
 *   Summary          the price chain from base cost to the all-in tender, and where the gates stand
 *   QS Takeoff       every item with its quantity, rate and amount
 *   Build-up         every resource row behind those amounts, with its check flag
 *   Commercial       the commercial lines CA01-CA24 with what each contributes
 *   Price schedule   the tender in the client's own format
 *   Subcontracts     the subcontract packages carried
 *   Scope            each requirement with its owner, treatment and standing
 *   Quotes           the quote register
 *   Procurement      the packages out for pricing and the quote selected for each (when procurement has been started)
 */
import ExcelJS from "exceljs";
import { cents, type Dec } from "@blackline/engine";
import type { computeTenderEstimate, TenderInputs } from "../estimate.js";

type Estimate = ReturnType<typeof computeTenderEstimate>;

const MONEY = "#,##0.00;[Red]-#,##0.00";
const m = (x: Dec | string | number | null | undefined): number | null => (x === null || x === undefined || x === "" ? null : Number(cents(x as Dec).toFixed(2)));
const q = (x: Dec | string | number | null | undefined): number | null => (x === null || x === undefined || x === "" ? null : Number(x.toString()));

function sheet(wb: ExcelJS.Workbook, name: string, widths: number[], header: string[], opts: { money?: number[]; qty?: number[] } = {}) {
  const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = widths.map((w) => ({ width: w }));
  const h = ws.addRow(header);
  h.font = { bold: true };
  h.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDCDCDC" } };
  h.border = { bottom: { style: "thin" } };
  for (const c of opts.money ?? []) ws.getColumn(c).numFmt = MONEY;
  for (const c of opts.qty ?? []) ws.getColumn(c).numFmt = "#,##0.###";
  return ws;
}
const bold = (row: ExcelJS.Row) => { row.font = { bold: true }; row.border = { top: { style: "thin" } }; return row; };

export async function estimateWorkbook(e: Estimate, inputs: TenderInputs, o: { title: string; subtitle: string }): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Blackline";
  wb.created = new Date();

  // ---- Summary
  const sm = wb.addWorksheet("Summary");
  sm.columns = [{ width: 52 }, { width: 20 }, { width: 70 }];
  sm.addRow([o.title]).font = { bold: true, size: 14 };
  sm.addRow([o.subtitle]).font = { color: { argb: "FF5C5C5C" } };
  sm.addRow([]);
  const line = (label: string, v: Dec | string | number | null, strong = false) => {
    const r = sm.addRow([label, m(v)]);
    r.getCell(2).numFmt = MONEY;
    if (strong) bold(r);
  };
  const t = e.tender, c = e.consolidated;
  line("Base direct estimate", t.baseDirect); line("Pre-margin additions (allowances and risk)", t.preMarginTotal); line("Subtotal before commercial adjustments", t.subtotal, true);
  line("Own works: company overhead", t.overhead); line("Own works: contractor profit", t.profit); line("Own works tender excl. GST", t.tenderExclGst, true);
  sm.addRow([]);
  line("Own works before overhead and profit (incl. management reserve)", c.ownWorks); line("Subcontract packages", c.overlaysTotal); line("Gross known package", c.grossKnownPackage, true);
  line("Overhead on the package", c.overhead); line("Bonds and securities", c.bonds); line("Retention finance", c.retentionFinance); line("Profit on the package", c.profit);
  line("Working all-in tender excl. GST", c.allInTender, true);
  const gm = sm.addRow(["Gross margin on sell", q(c.grossMarginOnSell.times(100))]); gm.getCell(2).numFmt = '0.00"%"';
  if (!c.confirmedOverlap.isZero()) { sm.addRow([]); line("Confirmed overlap (not removed from the all-in)", c.confirmedOverlap); }
  sm.addRow([]);
  sm.addRow(["Where the gates stand"]).font = { bold: true };
  for (const [label, text] of [["Scope", e.scope.gate], ["Risk Truth", e.riskTruth.gate], ["Documents", e.documents.gate], ["Procurement", e.procurement.gate]] as const) sm.addRow([label, "", text]);
  sm.addRow(["Client price schedule", "", e.schedule.reconciles ? "Adds up to the all-in tender" : "DOES NOT add up to the all-in tender"]);
  if (e.reconciled !== null) sm.addRow(["Against the source workbook", "", e.reconciled ? "Agrees" : "Differs (expected once edited)"]);

  // ---- QS Takeoff
  const qs = sheet(wb, "QS Takeoff", [10, 30, 56, 8, 14, 14, 16], ["Code", "Section", "Description", "Unit", "Quantity", "Rate", "Amount"], { money: [6, 7], qty: [5] });
  for (const l of e.qs.lines) qs.addRow([l.code, l.section, l.description, l.unit, q(l.quantity), l.quantity.isZero() ? null : m(l.rate), m(l.amount)]);
  bold(qs.addRow(["", "", "Total direct cost", "", null, null, m(e.qs.totalDirect)]));

  // ---- Build-up (the engine skips rows with no QS code; results line up with the rows that have one)
  const lib = new Map(inputs.library.map((r) => [r.code, r.description ?? ""]));
  const bu = sheet(wb, "Build-up", [14, 10, 36, 13, 12, 36, 20, 12, 12, 16, 10, 24], ["Row", "QS code", "Task", "Type", "Resource", "Resource description", "Calculation", "Hours", "Rate", "Cost", "Verified", "Check"], { money: [9, 10], qty: [8] });
  inputs.rows.filter((r) => r.qsCode).forEach((src, i) => {
    const r = e.rows[i]!;
    bu.addRow([r.rowId, src.qsCode, src.task ?? "", src.resourceType ?? "", src.resourceCode ?? "", lib.get(src.resourceCode ?? "") ?? "", src.mode ?? "", q(r.appliedDurationHrs), m(r.appliedRate), m(r.cost), src.verified ?? "", r.qaFlag]);
  });

  // ---- Commercial
  const cm = sheet(wb, "Commercial", [8, 62, 18, 9, 10, 14, 16, 18], ["Line", "Description", "Basis", "Included", "Percent", "Fixed sum", "Engine value", "Amount in the price"], { money: [6, 7, 8] });
  const own: Record<string, Dec> = { CA17: t.overhead, CA18: t.profit, CA19: t.bonds, CA20: t.retentionFinance };
  for (const l of e.commercial) {
    const amt = t.additions.get(l.ref) ?? own[l.ref];
    cm.addRow([l.ref, l.name, l.method, l.include, l.pct === undefined || l.pct === null || String(l.pct) === "0" ? null : q(l.pct as string), m(l.pcSum as string), m(l.engineValue as string), l.include === "Yes" ? m(amt) : null]);
  }

  // ---- Price schedule
  const ps = sheet(wb, "Price schedule", [12, 70, 18], ["Ref", "Description", "Amount"], { money: [3] });
  for (const g of e.schedule.groups) {
    const gr = ps.addRow([g.code, g.name, null]); gr.font = { bold: true }; gr.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F2F2" } };
    for (const ln of g.lines) ps.addRow([ln.ref, ln.trade, m(ln.amount)]);
    if (e.schedule.groups.length > 1) bold(ps.addRow(["", `Total ${g.name}`, m(g.total)]));
  }
  bold(ps.addRow(["", "Total tender price excluding GST", m(e.schedule.total)]));
  if (!e.schedule.reconciles) ps.addRow(["", `NOT RECONCILED: ${e.schedule.problems.join(" ")} Unmapped: ${e.schedule.unmapped.length}`, null]);

  // ---- Subcontracts
  const sc = sheet(wb, "Subcontracts", [44, 18], ["Subcontract package", "Amount"], { money: [2] });
  for (const ov of inputs.overlays) sc.addRow([ov.name, m(ov.amount as string)]);
  bold(sc.addRow(["Total", m(c.overlaysTotal)]));

  // ---- Scope
  const sp = sheet(wb, "Scope", [10, 24, 44, 14, 14, 12, 22, 22, 22, 70], ["Ref", "Group", "Requirement", "Owner", "Treatment", "Standing", "Estimate lines", "Register", "Quotes", "To look at"]);
  for (const it of e.scope.items) sp.addRow([it.ref, it.group, it.title, it.owner, it.treatment, it.status, it.cost_refs, it.register_refs, it.quote_refs, it.problems.join(" ")]);

  // ---- Quotes
  const qt = sheet(wb, "Quotes", [9, 26, 28, 12, 16, 22, 14, 40], ["Ref", "Package", "Supplier", "Estimate", "Amount", "Status", "Valid until", "Documents"], { money: [5] });
  for (const x of inputs.quotes ?? []) qt.addRow([x.ref, x.package, x.supplier, x.estimate_ref, m(x.amount), x.status, x.valid_until, x.documents]);

  // ---- Procurement
  if (e.procurement.packages.length) {
    const pc = sheet(wb, "Procurement", [40, 10, 28, 16, 16, 16, 16, 16], ["Package", "Quotes", "Selected", "Quoted", "Levelled", "In the estimate", "Difference", "Standing"], { money: [4, 5, 6, 7] });
    for (const p of e.procurement.packages) {
      const s = p.selectedBid;
      pc.addRow([p.name, p.bids.length, s ? (s.supplier || s.ref) : "", s ? m(s.quoted) : null, s ? m(s.levelled) : null, p.estimate ? m(p.estimate) : null, p.variance ? m(p.variance) : null, p.status]);
    }
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}
