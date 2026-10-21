/**
 * Import INPUTS (constants) and display metadata from a Master Estimate Workbook (.xlsx), ported from QSi Pro
 * (engine/tender_engine/importers/master_workbook.py).
 *
 * Inputs are read from constant cells, so the engine genuinely recomputes every figure. A cell that holds a formula gives the
 * value Excel last calculated for it; the platform recalculates everything downstream itself. The values the workbook displayed
 * for its key totals are kept as `reference`, so the platform can prove it reproduces them.
 *
 * Not ported yet: the Cover & Instructions register (documents, assumptions, exclusions, RFIs), Supplier Quote Register,
 * Scope Coverage and the MS Project Import fallback for the programme.
 */
import ExcelJS from "exceljs";
import { D, ZERO } from "@blackline/engine";
import type { TenderInputs, CommercialLine } from "../estimate.js";
import * as mr from "../managementReserve.js";
import type { BuildUpRow, LibraryRate, Overlay, QSItem, WeatherToolRun } from "../models.js";
import type { Programme, ProgrammeTask } from "../programme.js";
import type { RegisterItem } from "../register.js";
import { FIELDS as RT_FIELDS, LIMITS as RT_LIMITS, MODES as RT_MODES, OWNERS as RT_OWNERS, YESNO, type Exposure } from "../riskTruth.js";

type Cell = ExcelJS.Cell;
type Sheet = ExcelJS.Worksheet;

// ---- cell access ---------------------------------------------------------------------------------------------------------
const isFormula = (v: unknown): v is { formula?: string; sharedFormula?: string; result?: unknown } =>
  v !== null && typeof v === "object" && !(v instanceof Date) && ("formula" in v || "sharedFormula" in v);

const plain = (v: unknown): unknown => {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("richText" in o) return (o.richText as { text: string }[]).map((t) => t.text).join("");
    if ("text" in o && "hyperlink" in o) return o.text;
    if ("error" in o) return String(o.error);
    if ("result" in o) return plain(o.result);
  }
  return v;
};

/** The value of a cell: for a formula, the value Excel last calculated (null if it was never calculated). */
const val = (c: Cell): unknown => (isFormula(c.value) ? plain(c.value.result) : plain(c.value));
/** The formula text of a cell, or its typed text. */
const fx = (c: Cell): string => (isFormula(c.value) ? `=${c.value.formula ?? ""}` : String(plain(c.value) ?? ""));

const str = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 19).replace("T", " ");
  return String(v).trim();
};
const num = (v: unknown): v is number => typeof v === "number" && !Number.isNaN(v);
const numOr0 = (x: unknown): number => {
  if (typeof x === "boolean" || x === null || x === undefined || x === "") return 0;
  if (num(x)) return x;
  const n = Number(String(x).replace(/,/g, "").replace(/\$/g, "").trim());
  return Number.isNaN(n) ? 0 : n;
};
const nOrNull = (v: unknown) => (v === null || v === undefined || v === "" ? null : new D(String(v)));
const dec = (v: unknown) => (v === null || v === undefined || v === "" ? ZERO : new D(String(v)));

const at = (ws: Sheet, r: number, c: number) => ws.getCell(r, c);
const a1 = (ws: Sheet, addr: string) => ws.getCell(addr);

/** A number cell that holds words (TBC, n/a, a stray note) stops the import with the sheet, row and item named. */
function checkNumbers(sheet: string, row: number, code: unknown, cells: [string, unknown][]) {
  for (const [what, v] of cells) {
    if (v === null || v === undefined || v === "" || (num(v) && typeof v !== "boolean")) continue;
    if (Number.isNaN(Number(String(v).replace(/,/g, "").replace(/\$/g, "").trim())))
      throw new Error(`${sheet} row ${row} (${str(code)}): the ${what} is "${str(v).slice(0, 40)}", which is not a number. Change it to a number in the workbook and upload it again.`);
  }
}

const CODE_LIKE = /^[A-Za-z0-9]+(?:[-_./][A-Za-z0-9]+){0,4}$/; // one word, no spaces: PG01, JW-PG01, ALLIED-SUB-SURVEY-ASB

// ---- cover meta ------------------------------------------------------------------------------------------------------------
function coverMeta(ws: Sheet): Record<string, string> {
  const wanted: Record<string, string> = {
    Project: "project", Location: "location", "Current drawings": "drawings", "Issue date": "issue_date", Scope: "scope", GST: "gst",
    Programme: "programme", Weather: "weather", "Price status": "price_status", Commercial: "commercial",
  };
  const meta: Record<string, string> = {};
  ws.eachRow({ includeEmpty: false }, (row) => {
    const cells: unknown[] = [];
    row.eachCell({ includeEmpty: false }, (c) => {
      const v = val(c);
      if (v !== null && v !== "") cells.push(v);
    });
    cells.forEach((v, i) => {
      if (typeof v === "string" && v in wanted && !(wanted[v]! in meta) && i + 1 < cells.length) {
        const nxt = cells[i + 1];
        if (typeof nxt === "string" && nxt in wanted) return; // the value cell is empty and the next filled cell is another label
        meta[wanted[v]!] = str(nxt);
      }
    });
  });
  const snap = str(val(at(ws, 2, 1)));
  if (snap) meta.snapshot = snap;
  return meta;
}

// ---- Risk Truth tab -----------------------------------------------------------------------------------------------------------
const ragOf = (t: string) => {
  const u = t.toUpperCase();
  return /\bRED\b/.test(u) ? "RED" : /\bAMBER\b/.test(u) ? "AMBER" : /\bGREEN\b/.test(u) ? "GREEN" : "";
};

/** Risks (rows from 25: ID, description, class, likelihood, impact, rating, response, owner, RFI/action, baseline, status) and exposures
 *  (header row 'Exposure ID' onwards). Tolerant of the one-column shift that some workbook rows carry from column G. */
function riskTruthTab(ws: Sheet): { risks: RegisterItem[]; exposures: Exposure[] } {
  let top: number | null = null;
  let hdr: number | null = null;
  for (let r = 1; r <= ws.rowCount; r++) {
    if (str(val(at(ws, r, 1))) === "Risk ID") top = r;
    if (str(val(at(ws, r, 1))) === "Exposure ID") {
      hdr = r;
      break;
    }
  }
  if (hdr === null) return { risks: [], exposures: [] };

  const risks: RegisterItem[] = [];
  for (let r = top ? top + 1 : hdr; r < hdr; r++) {
    const a = str(val(at(ws, r, 1)));
    if (!/^[A-Z]{2}\d+$/.test(a)) continue;
    const g = (c: number) => str(val(at(ws, r, c)));
    const status = g(11);
    const detail = g(7) + (g(10) ? `\n\nTender baseline: ${g(10)}` : "") + (g(3) ? `\n\nClass: ${g(3)}` : "");
    risks.push({
      id: `R-${a}`, kind: "risk", ref: a, title: g(2).slice(0, 3000), detail: detail.slice(0, 3000), action: g(9).slice(0, 3000), status,
      rag: ["RED", "AMBER", "GREEN"].includes(status.toUpperCase()) ? status.toUpperCase() : "", owner: g(8).slice(0, 3000), likelihood: g(4), impact: g(5), rating: g(6),
    });
  }

  const exposures: Exposure[] = [];
  for (let r = hdr + 1; r <= ws.rowCount; r++) {
    const ref = str(val(at(ws, r, 1)));
    if (!ref || !/^[A-Z]{2}\d+-\d+$/.test(ref)) continue;
    const c = (col: number, off = 0) => str(val(at(ws, r, col + off)));
    const off = (RT_MODES as readonly string[]).includes(c(10)) && !(RT_MODES as readonly string[]).includes(c(9)) ? 1 : 0;
    const n = (v: string) => (/^-?\d+(\.\d+)?$/.test(v || "") ? v : "");
    const yn = (v: string) => ((YESNO as readonly string[]).includes(v) ? v : "");
    const treat = c(6) + (off && c(7) ? ` | ${c(7)}` : "");
    const item = { id: `X-${ref.replace(/[^A-Za-z0-9]/g, "").slice(0, 12)}`, ...Object.fromEntries(RT_FIELDS.map((f) => [f, ""])) } as Exposure;
    Object.assign(item, {
      ref, risk_id: c(2), consequence: c(3), driver: c(4), cost_ref: c(5), treatment: treat, baseline_amount: n(c(7, off)), residual: c(8, off),
      mode: (RT_MODES as readonly string[]).includes(c(9, off)) ? c(9, off) : "", qty: n(c(10, off)), unit: c(11, off), unit_rate: n(c(12, off)),
      probability: n(c(13, off)), provision: n(c(15, off)), owner: (RT_OWNERS as readonly string[]).includes(c(16, off)) ? c(16, off) : "",
      distinct: yn(c(17, off)), target: c(18, off), include: yn(c(19, off)) || "No", overlap_group: c(21, off), embedded: c(22, off),
      evidence: ragOf(c(23, off)), evidence_note: c(23, off), integration_complete: yn(c(25, off)), basis: c(27, off), action: c(28, off), source: c(29, off),
    });
    for (const f of RT_FIELDS) item[f] = item[f].slice(0, RT_LIMITS[f]);
    exposures.push(item);
  }
  return { risks, exposures };
}

// ---- management reserve ----------------------------------------------------------------------------------------------------------
/** A workbook whose CA16 Management Reserve is an included fixed amount becomes an adjudication block whose selected reserve is that amount
 *  (total unchanged). The workbook's own "MANAGEMENT RESERVE - ADJUDICATION BASIS" block supplies the unresolved items and the rationale.
 *  Probabilities are NOT invented: the workbook records none (UNKNOWN). */
function reserveFromCommercial(commercial: CommercialLine[], ws: Sheet | null): mr.ReserveBlock | null {
  const ca = commercial.find((c) => c.ref === "CA16");
  if (!ca || ca.include !== "Yes" || ca.method !== "Fixed Amount" || dec(ca.pcSum).lte(0)) return null;
  let basis = ca.note ?? "";
  const items: mr.ReserveItem[] = [];
  if (ws) {
    let top: number | null = null;
    for (let r = 1; r <= ws.rowCount; r++)
      if (str(val(at(ws, r, 1))).toUpperCase().startsWith("MANAGEMENT RESERVE - ADJUDICATION BASIS")) { top = r; break; }
    if (top) {
      const hdr = top + 1, row = top + 2;
      const rows = new Map<string, number>();
      for (let r = top + 2; r < top + 9; r++) rows.set(str(val(at(ws, r, 1))), r);
      const rate = rows.get("Selected reserve rate"), note = rows.get("Probability note");
      const extra = [rate ? str(val(at(ws, rate, 4))) : "", note ? str(val(at(ws, note, 4))) : ""].filter(Boolean).join(" ");
      if (extra) basis = `${basis}\n\nWorkbook adjudication basis: ${extra}`.trim();
      for (let col = 5; col < 9; col++) {
        const head = str(val(at(ws, hdr, col))), text = str(val(at(ws, row, col)));
        if (!head || !text) continue;
        const m = /\$\s*([\d.,]+)\s*k\b/i.exec(text);
        const zero = /^[~+]?\$0\b/.test(text);
        let impact = "";
        if (m) impact = !zero ? String(Math.round(parseFloat(m[1]!.replace(/,/g, "")) * 1000)) : "0";
        else if (zero) impact = "0";
        const unq = /unquantified/i.test(text) && (zero || !m);
        const status = unq ? "Unquantified" : /proxy|floor/i.test(text) ? "Proxy" : "Quantified";
        items.push(mr.buildItem(`M-wb${String(col - 4).padStart(4, "0")}`, {
          title: `${head.replace(/\s+RED$/, "").trim()} (red item)`, description: text, basis: "Sell", impact: status === "Unquantified" ? "" : impact,
          impact_status: status, prob_status: "UNKNOWN",
          prob_basis: "Workbook records no evidenced probability (an earlier 50/50 discussion was a heuristic only). Enter a supportable range to weight this item.",
        }, items));
      }
    }
  }
  const blk = mr.newBlock(dec(ca.pcSum).toString(), basis.slice(0, 3000));
  blk.items = items;
  return blk;
}

// ---- consolidated package ----------------------------------------------------------------------------------------------------------
// The overlay names the platform already uses (so schedules, mappings and saved work keep working) for the Hobsonville wording of each package.
const LEGACY_OVERLAY_NAMES: [string, string][] = [
  ["coast concrete foundation", "Coast Concrete foundation / floor"], ["public stormwater", "Allied public stormwater / detention base"],
  ["public setout", "Allied public setout / as-built / signoff"], ["private drainage", "Allied private drainage"],
];

/** Subcontract packages, by reading what the rows say: a package is a row with an amount that is NOT in the siteworks direct cost (column D = No)
 *  and is not a calculated total. The confirmed overlap is the row whose label says overlap. */
function overlaysFromConsolidated(ws: Sheet): { overlays: Overlay[]; overlap: Decimal } {
  const overlays: Overlay[] = [];
  let overlap = ZERO;
  for (let r = 5; r <= Math.min(ws.rowCount, 60); r++) {
    const label = str(val(at(ws, r, 1))), amount = val(at(ws, r, 2)), cls = str(val(at(ws, r, 3))), inc = str(val(at(ws, r, 4)));
    const low = label.toLowerCase();
    if (low.startsWith("gross") || low.startsWith("current known package") || low.startsWith("working all-in")) {
      if (low.startsWith("gross")) break;
      continue;
    }
    if (!num(amount)) continue;
    if (low.includes("overlap")) { overlap = new D(String(amount)); continue; }
    if (inc.toLowerCase() === "no" && !cls.toUpperCase().includes("CALCULATED")) {
      const name = LEGACY_OVERLAY_NAMES.find(([k]) => low.includes(k))?.[1] ?? label.slice(0, 80);
      overlays.push({ name, amount: new D(String(amount)), kind: cls || "QUOTED" });
    }
  }
  return { overlays, overlap };
}

// ---- programme -----------------------------------------------------------------------------------------------------------------------
/** Programme Export: one row per QS code plus control tasks (PRG-..., DRN-...); override days, predecessor codes, basis and notes. */
function programmeFromSheet(ws: Sheet | null, qsCodes: Set<string>, start: string, daysPerWeek: number): Programme | null {
  if (!ws) return null;
  const tasks: ProgrammeTask[] = [];
  for (let r = 7; r <= ws.rowCount; r++) {
    const row = (c: number) => val(at(ws, r, c));
    const codeRaw = row(4);
    if (typeof codeRaw !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$/.test(codeRaw.trim())) continue;
    const code = codeRaw.trim();
    const name = str(row(5));
    if (!name) continue;
    const over = row(12);
    let override: string | null = null;
    if (over !== null && over !== "") {
      const n = Number(String(over));
      override = Number.isFinite(n) ? String(Math.trunc(n)) : null;
    }
    const preds = str(row(16)).split(/[,;\s]+/).filter(Boolean);
    tasks.push({
      id: `P-${String(tasks.length + 1).padStart(5, "0")}`, code, name: name.slice(0, 200), qs_code: qsCodes.has(code) ? code : "", override_days: override,
      predecessors: preds, hammock: str(row(3)).toUpperCase().startsWith("PRELIMINARIES"), basis: str(row(15)).slice(0, 500), note: str(row(24)).slice(0, 500),
    });
  }
  if (!tasks.length) return null;
  return { start, days_per_week: daysPerWeek, hours_per_day: 8, tasks };
}

// ---- main ------------------------------------------------------------------------------------------------------------------------------
export interface ImportedWorkbook extends TenderInputs {
  excelRows: number[];
  controls: Record<string, string>;
  notes: string[];
  meta: Record<string, string>;
  /** The loaded workbook, for reading the cached (displayed) cells. */
  workbook: ExcelJS.Workbook;
}

type Decimal = InstanceType<typeof D>;

/** `source` is a file path, or the workbook's bytes (for an upload). */
export async function loadMasterWorkbook(source: string | ExcelJS.Buffer): Promise<ImportedWorkbook> {
  const wb = new ExcelJS.Workbook();
  if (typeof source === "string") await wb.xlsx.readFile(source);
  else await wb.xlsx.load(source);
  const sheet = (n: string): Sheet | null => wb.getWorksheet(n) ?? null;
  const names = wb.worksheets.map((w) => w.name);

  // Only these four sheets are essential. Everything else is optional: a workbook from an older or different job that lacks a sheet still
  // loads, and the notes say what was left out and how to fill it in on the platform.
  const required: Record<string, string> = { "Resource Rate Library": "the rates", "QS Takeoff": "the quantities", "Resource Build-Up": "the cost build-up rows", "Commercial Inputs": "overhead, margin and allowances" };
  const missing = Object.entries(required).filter(([n]) => !names.includes(n)).map(([n, what]) => `${n} (${what})`);
  if (missing.length)
    throw new Error(`This doesn't look like a Master Estimate Workbook. These sheets are needed and are missing: ${missing.join(", ")}. The sheets found were: ${names.slice(0, 12).join(", ")}${names.length > 12 ? "…" : ""}.`);
  const notes: string[] = [];

  // library
  const library: LibraryRate[] = [];
  let ws = sheet("Resource Rate Library")!;
  for (let r = 5; r <= ws.rowCount; r++) {
    const code = val(at(ws, r, 1));
    if (code && (r <= 85 || (CODE_LIKE.test(str(code)) && str(code).length <= 40 && num(val(at(ws, r, 9)))))) {
      checkNumbers("Resource Rate Library", r, code, [["rate", val(at(ws, r, 9))]]);
      library.push({
        code: String(code), category: str(val(at(ws, r, 2))), description: str(val(at(ws, r, 3))), unit: str(val(at(ws, r, 5))),
        operatorIncluded: str(val(at(ws, r, 7))), fuelIncluded: str(val(at(ws, r, 8))), baseRate: dec(val(at(ws, r, 9))), source: str(val(at(ws, r, 13))),
      });
    }
  }

  // QS takeoff
  const qs: QSItem[] = [];
  ws = sheet("QS Takeoff")!;
  for (let r = 3; r <= ws.rowCount; r++) {
    const code = val(at(ws, r, 2));
    if (code && (r <= 40 || (CODE_LIKE.test(str(code)) && str(code).length <= 24 && num(val(at(ws, r, 5)))))) {
      checkNumbers("QS Takeoff", r, code, [["quantity", val(at(ws, r, 5))]]);
      qs.push({ code: String(code), section: str(val(at(ws, r, 1))), description: str(val(at(ws, r, 3))), unit: str(val(at(ws, r, 4))), quantity: dec(val(at(ws, r, 5))) });
    }
  }

  // build-up rows
  const rows: BuildUpRow[] = [];
  const excelRows: number[] = [];
  ws = sheet("Resource Build-Up")!;
  for (let r = 7; r <= ws.rowCount; r++) {
    const code = val(at(ws, r, 2));
    if (!code || (r > 306 && !(CODE_LIKE.test(str(code)) && str(val(a1(ws, `N${r}`)))))) continue;
    const c = (col: string) => val(a1(ws, `${col}${r}`));
    checkNumbers("Resource Build-Up", r, code, [["productivity", c("I")], ["duration override", c("L")], ["count", c("R")], ["quantity", c("S")], ["utilisation", c("U")], ["waste", c("V")], ["job rate", c("X")]]);
    rows.push({
      qsCode: String(code), mode: str(c("N")), resourceType: str(c("O")), resourceCode: str(c("P")), productivityRate: nOrNull(c("I")),
      durationOverrideHrs: nOrNull(c("L")), count: nOrNull(c("R")), manualQty: nOrNull(c("S")), utilisation: nOrNull(c("U")), waste: nOrNull(c("V")),
      jobRateOverride: nOrNull(c("X")), task: str(c("H")), verified: str(c("AH")), weatherExposed: str(c("AK")), weatherTaskType: str(c("AL")),
    });
    excelRows.push(r);
  }
  // permanent row identities (initially the display id)
  const seq = new Map<string, number>();
  for (const row of rows) {
    seq.set(row.qsCode, (seq.get(row.qsCode) ?? 0) + 1);
    row.uid = `${row.qsCode}-${String(seq.get(row.qsCode)).padStart(3, "0")}`;
  }
  const uidAt = new Map(excelRows.map((r, i) => [r, rows[i]!.uid!]));

  // weather
  const noLinks = { dailyUid: "", hoursPerDay: 8 as number, weeklyUids: [] as string[] };
  let tool: WeatherToolRun;
  let weatherMeta: Record<string, string>;
  let weatherLinks = { ...noLinks };
  let recovery: Decimal;
  const wr = sheet("Weather Risk");
  if (!wr) {
    notes.push("No Weather Risk sheet in the workbook: the weather allowance is zero. Set the weather tool up on the Weather Risk page.");
    tool = { exposedPool: 0, rainWetGroundCost: 0, criticalPathDelayWd: 0, additionalBilledWeeks: 0, windSensitivityCost: 0, includeWind: false };
    weatherMeta = { station: "", start: "", baseline_wd: "0", wd_per_week: "5", tool_version: "", tool_station: "", confidence: "NOT RUN", rerun_status: "No weather sheet in the imported workbook", delay_wd: "0", dry_programme_wd: "0" };
    recovery = ZERO;
  } else {
    const w = (addr: string) => val(a1(wr, addr));
    const numstr = (x: unknown, dflt: string) => (num(x) ? String(x) : !Number.isNaN(Number(String(x ?? "").replace(/,/g, "").trim())) && String(x ?? "").trim() !== "" ? String(x).trim() : dflt);
    tool = {
      exposedPool: dec(numOr0(w("B23"))), rainWetGroundCost: dec(numOr0(w("B24"))), criticalPathDelayWd: dec(numOr0(w("B26"))),
      additionalBilledWeeks: dec(numOr0(w("B27"))), windSensitivityCost: dec(numOr0(w("B28"))), includeWind: w("B29") === "Yes",
    };
    weatherMeta = {
      station: str(w("B6")), start: str(w("B7")).slice(0, 10), baseline_wd: numstr(w("B8"), "0"), wd_per_week: numstr(w("B9"), "5"), tool_version: str(w("B19")),
      tool_station: str(w("B20")), confidence: str(w("B30")), rerun_status: str(w("B31")), delay_wd: numstr(w("B26"), "0"), dry_programme_wd: numstr(w("B8"), "0"),
    };
    recovery = dec(numOr0(w("B16")));
    // The workbook derives daily time-related prelims and weekly hire from specific build-up rows (formulas like =Y584*8 and =Y295+Y330).
    const m13 = /Y(\d+)\*(\d+)/.exec(fx(a1(wr, "B13")));
    const m14 = [...fx(a1(wr, "B14")).matchAll(/Y(\d+)/g)].map((m) => Number(m[1]));
    if (m13 && m14.length && uidAt.has(Number(m13[1])) && m14.every((x) => uidAt.has(x)))
      weatherLinks = { dailyUid: uidAt.get(Number(m13[1]))!, hoursPerDay: Number(m13[2]), weeklyUids: m14.map((x) => uidAt.get(x)!) };
    else notes.push("The workbook's weather sheet does not point at build-up rows for daily preliminaries and weekly hire, so the weather costs are not linked. Link them on the Weather Risk page if you want the platform to work the weather allowance out.");
  }

  // commercial inputs
  const commercial: CommercialLine[] = [];
  const ci = sheet("Commercial Inputs")!;
  for (let r = 5; r < 29; r++) {
    const ref = val(at(ci, r, 1));
    if (ref && String(ref).startsWith("CA")) {
      checkNumbers("Commercial Inputs", r, ref, [["percentage", val(at(ci, r, 4))], ["amount", val(at(ci, r, 5))]]);
      commercial.push({
        ref: String(ref), name: str(val(at(ci, r, 2))), method: str(val(at(ci, r, 3))), pct: dec(val(at(ci, r, 4))), pcSum: dec(val(at(ci, r, 5))),
        include: str(val(at(ci, r, 6))), basis: str(val(at(ci, r, 8))), note: str(val(at(ci, r, 13))),
      });
    }
  }

  // risk truth
  const rtSheet = sheet("Risk Truth");
  let riskFeed: Record<string, Decimal>;
  if (rtSheet) riskFeed = { CA01: dec(numOr0(val(a1(rtSheet, "B12")))), CA02: dec(numOr0(val(a1(rtSheet, "B13")))) };
  else {
    riskFeed = { CA01: ZERO, CA02: ZERO };
    notes.push("No Risk Truth sheet: no risk exposures were loaded and the risk allowances CA01 and CA02 are zero. Record exposures on the Risk Truth page.");
  }
  const rtTab = rtSheet ? riskTruthTab(rtSheet) : { risks: [] as RegisterItem[], exposures: [] as Exposure[] };

  // consolidated package
  let overlays: Overlay[] = [];
  let overlap: Decimal = ZERO;
  const cpSheet = sheet("Consolidated Package");
  if (cpSheet) {
    ({ overlays, overlap } = overlaysFromConsolidated(cpSheet));
    if (!overlays.length) notes.push("The Consolidated Package sheet lists no subcontract packages that could be recognised. Add them on the Consolidated Package page.");
  } else notes.push("No Consolidated Package sheet: no subcontract packages were loaded, so the all-in package equals the siteworks tender. Add subcontract quotes on the Consolidated Package page.");

  const cover = sheet("Cover & Instructions");
  const rv = sheet("Rate Verification");
  if (!rv) notes.push("No Rate Verification sheet: the rate-evidence counts are blank.");
  const g = (s: Sheet | null, cell: string) => (s ? str(val(a1(s, cell))) : "");
  const controls: Record<string, string> = {
    release_status: g(rtSheet, "B15"), red_risks: g(rtSheet, "B16"), red_exposures: g(rtSheet, "B17"), duplicate_gate: g(rtSheet, "B18"),
    programme_gate: g(rtSheet, "B19"), tender_equals_risk_truth: g(rtSheet, "B21"), rate_green: g(rv, "B4"), rate_amber: g(rv, "B5"), rate_red: g(rv, "F4"),
    rate_green_cost: g(rv, "C4"), rate_amber_cost: g(rv, "C5"), rate_red_cost: g(rv, "G4"), cover_release: "",
  };

  // what the source workbook displayed, so the platform can prove it reproduces it
  let reference: Record<string, number> | null = null;
  const tb = sheet("Tender Build-Up");
  if (tb) {
    const n = (s: Sheet, addr: string) => numOr0(val(a1(s, addr)));
    reference = {
      "Base direct estimate": n(tb, "B20"), "Pre-margin additions": n(tb, "B39"), "Subtotal before commercial adjustments": n(tb, "B40"),
      "Company overhead (CA17)": n(tb, "B42"), "Contractor profit (CA18)": n(tb, "B43"), "Own works tender excl. GST": n(tb, "B47"),
    };
    if (wr) reference["Weather allowance (CA10)"] = n(wr, "B38");
    if (cpSheet) {
      reference["Gross known package"] = n(cpSheet, "B12");
      reference["Working all-in tender excl. GST"] = n(cpSheet, "F56");
    }
  } else notes.push("No Tender Build-Up sheet: the platform's totals could not be compared with the workbook's own, so the revision shows no reconciliation.");

  const start = weatherMeta.start ?? "";
  const dpw = /^\d+$/.test(weatherMeta.wd_per_week ?? "") ? Number(weatherMeta.wd_per_week) : 5;
  const qsCodes = new Set(qs.map((q) => q.code));

  return {
    reference, meta: cover ? coverMeta(cover) : {}, library, qs, rows, excelRows, tool, recovery, commercial, riskFeed, overlays, overlap, weatherMeta,
    weatherLinks, controls, register: rtTab.risks, notes, riskTruth: rtTab.exposures, managementReserve: reserveFromCommercial(commercial, ci),
    programme: programmeFromSheet(sheet("Programme Export"), qsCodes, start, dpw), workbook: wb,
  };
}

/** The value Excel calculated for a cell (for golden tests against the workbook's own displayed numbers). */
export function cachedValue(wb: ExcelJS.Workbook, sheetName: string, addr: string): unknown {
  const ws = wb.getWorksheet(sheetName);
  return ws ? val(ws.getCell(addr)) : null;
}
