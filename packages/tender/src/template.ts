/**
 * A blank tender: what a job starts from when it is not imported from a workbook. It has the standard commercial stack CA01-CA24 (the same lines and
 * wording as the Master Estimate Workbook), the packages every tender is built from, and nothing priced. Overhead and profit are the only lines switched
 * on that cost anything, and the person starting the tender says what they are, so no margin is assumed on their behalf.
 *
 *   sections   QS sections are added afterwards, one package each (`sectionPackage`), so different estimators can hold different sections.
 *   defaults   the Risk Truth lines (CA01, CA02) are on because they cost nothing until exposures are recorded; the weather line is off until a weather
 *              setup exists; every other allowance is off until someone decides it applies.
 */
import { splitIntoPackages, type SeedPackage } from "./packaging.js";
import type { CommercialLine, TenderInputs } from "./estimate.js";

export class TemplateError extends Error {}

interface Std { ref: string; name: string; method: string; include: "Yes" | "No"; basis: string }
const PC = "No specialist engine linked - select PC Sum or %";

/** The standard lines, in the workbook's order. */
const STANDARD: Std[] = [
  { ref: "CA01", name: "Design / scope residual risk - Risk Truth linked", method: "Risk Engine", include: "Yes", basis: "Uses the linked Risk Truth engine amount" },
  { ref: "CA02", name: "Construction / execution residual risk - Risk Truth linked", method: "Risk Engine", include: "Yes", basis: "Uses the linked Risk Truth engine amount" },
  { ref: "CA03", name: "Escalation / tender validity allowance", method: "%", include: "No", basis: "Percentage of base direct cost" },
  { ref: "CA04", name: "Final subcontractor quote gap / market adjustment", method: "PC Sum", include: "No", basis: PC },
  { ref: "CA05", name: "Council / authority consent and inspection fees", method: "PC Sum", include: "No", basis: PC },
  { ref: "CA06", name: "Utility authority fees / relocations", method: "PC Sum", include: "No", basis: PC },
  { ref: "CA07", name: "Temporary works engineering / PS documentation", method: "PC Sum", include: "No", basis: PC },
  { ref: "CA08", name: "Abnormal ground / contamination / rock allowance", method: "PC Sum", include: "No", basis: PC },
  { ref: "CA09", name: "Construction dewatering / groundwater control", method: "PC Sum", include: "No", basis: PC },
  { ref: "CA10", name: "Weather risk allowance - linked approved engine", method: "Weather Engine", include: "No", basis: "Uses the linked Weather Risk amount once a weather setup exists" },
  { ref: "CA11", name: "Extended preliminaries beyond weather-adjusted tender baseline", method: "PC Sum", include: "No", basis: PC },
  { ref: "CA12", name: "Defects liability / maintenance beyond base", method: "PC Sum", include: "No", basis: PC },
  { ref: "CA13", name: "Stakeholder liaison / access marshals beyond base", method: "PC Sum", include: "No", basis: PC },
  { ref: "CA14", name: "Out-of-hours / restricted access premium", method: "PC Sum", include: "No", basis: PC },
  { ref: "CA15", name: "Unforeseen post-tender client scope additions", method: "PC Sum", include: "No", basis: PC },
  { ref: "CA16", name: "Management Reserve - residual tender-stage uncertainty (adjudication)", method: "Fixed Amount", include: "No", basis: "Uses a fixed management reserve once one is adjudicated" },
  { ref: "CA17", name: "Company overhead recovery", method: "Markup %", include: "Yes", basis: "Markup applied to the subtotal before profit" },
  { ref: "CA18", name: "Contractor profit", method: "Margin %", include: "Yes", basis: "TRUE MARGIN after overhead and other selected commercial costs" },
  { ref: "CA19", name: "Bonds / contract securities allowance", method: "%", include: "No", basis: "Applied if selected" },
  { ref: "CA20", name: "Retention finance / cashflow cost allowance", method: "%", include: "No", basis: "Applied if selected" },
  { ref: "CA21", name: "GST", method: "%", include: "No", basis: "Applied to tender total if selected" },
  { ref: "CA22", name: "Contract retention withholding", method: "%", include: "No", basis: "Visibility only" },
  { ref: "CA23", name: "Retention holding period", method: "Months", include: "No", basis: "Times retention release" },
  { ref: "CA24", name: "Deposit / advance payment", method: "%", include: "No", basis: "Part of tender value" },
];

/** A percentage as the engine holds it: a fraction between 0 and 1, from what a person typed (10 or 10%). Margin has to stay below 100%. */
export function fractionOf(v: unknown, what: string, max: number): string {
  const s = String(v ?? "").trim().replace(/%$/, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new TemplateError(`${what} needs to be a percentage, for example 10.`);
  const n = Number(s);
  if (n > max) throw new TemplateError(`${what} can't be more than ${max}%.`);
  return String(Number((n / 100).toFixed(4)));
}

/** The commercial lines of a blank tender, with the overhead and profit the person chose (percentages, e.g. "10" and "15"). */
export function standardCommercial(overheadPct: unknown, profitPct: unknown): CommercialLine[] {
  const oh = fractionOf(overheadPct, "Overhead", 100), pr = fractionOf(profitPct, "Profit margin", 60);
  return STANDARD.map((s) => ({
    ref: s.ref, name: s.name, method: s.method, include: s.include,
    pct: s.ref === "CA17" ? oh : s.ref === "CA18" ? pr : s.ref === "CA21" ? "0.15" : "0", pcSum: "0", basis: s.basis, note: "",
  }));
}

export function blankInputs(o: { project?: string; overheadPct?: unknown; profitPct?: unknown } = {}): TenderInputs {
  return {
    meta: { project: o.project ?? "" },
    library: [], qs: [], rows: [],
    weatherLinks: { dailyUid: "", hoursPerDay: 8, weeklyUids: [] },
    tool: { exposedPool: 0, rainWetGroundCost: 0, criticalPathDelayWd: 0, additionalBilledWeeks: 0 },
    commercial: standardCommercial(o.overheadPct ?? "10", o.profitPct ?? "15"),
    overlays: [], overlap: "0", reference: null,
    register: [], quotes: [], scope: [], riskTruth: [],
  };
}

/** The packages a blank tender is made of. */
export function blankTender(o: { project?: string; overheadPct?: unknown; profitPct?: unknown } = {}): SeedPackage[] {
  return splitIntoPackages(blankInputs(o));
}

const MAX_SECTION = 80;

/**
 * A new QS section: a package of its own, so it is checked out like any other. The name is how it reads on the takeoff, tidied (spaces collapsed) and
 * unique among the job's sections without regard to capitals.
 */
export function sectionPackage(name: unknown, existing: string[]): SeedPackage {
  const n = String(name ?? "").trim().replace(/\s+/g, " ");
  if (!n) throw new TemplateError("Name the section, for example Earthworks.");
  if (n.length > MAX_SECTION) throw new TemplateError(`That name is too long (limit ${MAX_SECTION} characters).`);
  if (n.toLowerCase() === "unassigned rows") throw new TemplateError("That name is used for rows that have no QS item. Choose another.");
  if (existing.some((e) => e.toLowerCase() === n.toLowerCase())) throw new TemplateError(`${n} is already a section.`);
  return { key: `qs:${n}`, name: n, kind: "qs-section", records: {} };
}
