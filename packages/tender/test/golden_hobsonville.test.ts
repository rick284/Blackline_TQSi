/**
 * Golden test: the engine, fed only the INPUTS of the Hobsonville Rev34E workbook, must reproduce the workbook's calculated results to
 * the cent. Ported from QSi Pro engine/tests/test_golden_hobsonville.py and test_programme.py (Hobsonville class).
 * Needs private/Rev34E.xlsx (client workbook: not committed, see .gitignore). Skipped when the file is absent.
 */
import { existsSync, readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { cents, D, ZERO, type Dec } from "@blackline/engine";
import {
  cachedValue, computeBuildup, computeConsolidated, computeQs, computeTender, computeTenderEstimate, computeWeather, d, loadMasterWorkbook,
  type CommercialInput, type ImportedWorkbook,
} from "../src/index.js";

const FILE = new URL("../../../private/Rev34E.xlsx", import.meta.url);
const present = existsSync(FILE);

const s = (x: { toString(): string }) => x.toString();
const c2 = (x: Dec) => s(cents(x));
const near = (a: Dec | number, b: unknown, tol = "0.000001") => new D(String(a)).minus(String(b ?? 0)).abs().lte(tol);
const cv = (wb: ImportedWorkbook, sheet: string, addr: string) => cachedValue(wb.workbook, sheet, addr);

describe.skipIf(!present)("Hobsonville Rev34E golden test", () => {
  let wb: ImportedWorkbook;
  let rows: ReturnType<typeof computeBuildup>;
  let qs: ReturnType<typeof computeQs>;
  let weather: ReturnType<typeof computeWeather>;
  let commercial: CommercialInput[];
  let tender: ReturnType<typeof computeTender>;
  let cons: ReturnType<typeof computeConsolidated>;

  beforeAll(async () => {
    wb = await loadMasterWorkbook(readFileSync(FILE));
    rows = computeBuildup(wb.rows, wb.qs, wb.library);
    qs = computeQs(wb.qs, rows);
    const byExcel = new Map(wb.excelRows.map((r, i) => [r, rows[i]!]));
    const rateOf = (uid: string) => rows[wb.rows.findIndex((r) => r.uid === uid)]!.appliedRate;
    weather = computeWeather(rows, wb.tool, {
      dailyPrelims: rateOf(wb.weatherLinks.dailyUid).times(d(wb.weatherLinks.hoursPerDay)),
      weeklyHire: wb.weatherLinks.weeklyUids.reduce((t, u) => t.plus(rateOf(u)), ZERO),
      recoveryAllowance: wb.recovery,
    });
    void byExcel;
    commercial = wb.commercial.map((c) => ({ ref: c.ref, name: c.name, method: c.method, include: c.include, pct: c.pct, pcSum: c.pcSum, engineValue: c.ref === "CA10" ? weather.allowance : d(wb.riskFeed?.[c.ref]) }));
    tender = computeTender(qs.totalDirect, commercial);
    cons = computeConsolidated(tender.subtotal, wb.overlays, wb.overlap, { commercial });
  });

  it("reads the cover register and the quote register", () => {
    const reg = wb.register ?? [];
    const of = (k: string) => reg.filter((x) => x.kind === k);
    expect([of("document").length, of("assumption").length, of("exclusion").length, of("rfi").length, of("risk").length]).toEqual([9, 9, 3, 13, 15]);
    expect(of("document")[0]).toMatchObject({ ref: "DOC-01", title: "Plans / drawings" });
    expect(of("assumption").map((x) => x.ref)).toEqual(["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9"]);
    const rfi = (ref: string) => of("rfi").find((x) => x.ref === ref)!;
    expect(rfi("RFI-05")).toMatchObject({ status: "CLOSED" });
    expect(rfi("RFI-06")).toMatchObject({ status: "OPEN", rag: "RED" });
    expect(new Set(reg.map((x) => x.id)).size).toBe(reg.length);

    const q = wb.quotes ?? [];
    expect(q.map((x) => x.ref)).toEqual(Array.from({ length: 14 }, (_, i) => `Q-${String(i + 1).padStart(2, "0")}`));
    expect(q[0]).toMatchObject({ package: "Allproof level-threshold drainage", estimate_ref: "ES03", qty: "44", unit: "lm", amount: "40000", supplier: "PlaceMakers Westgate / Allproof technical" });
    expect(q[10]!.amount).toBe("210606");
  });

  it("reproduces every build-up row of the workbook", () => {
    const bad: unknown[] = [];
    wb.excelRows.forEach((r, i) => {
      const res = rows[i]!;
      const cell = (col: string) => cv(wb, "Resource Build-Up", `${col}${r}`);
      if (res.rowId !== cell("A")) bad.push([r, "id", res.rowId, cell("A")]);
      if (!near(res.appliedDurationHrs, cell("M"))) bad.push([r, "hrs", s(res.appliedDurationHrs), cell("M")]);
      if (!near(res.appliedRate, cell("Y"))) bad.push([r, "rate", s(res.appliedRate), cell("Y")]);
      if (!near(res.cost, cell("Z"))) bad.push([r, "cost", s(res.cost), cell("Z")]);
      if (!near(res.weatherExposedCost, cell("AN"))) bad.push([r, "exposed", s(res.weatherExposedCost), cell("AN")]);
    });
    expect(bad.slice(0, 10)).toEqual([]);
    expect(wb.excelRows.length).toBe(64);
  });

  // Finding (not a calculation difference): in Rev34E the QA column (AI) is partly hand-typed and two formula cells hold cached text that
  // contradicts their own formula. The engine derives the flag from the rules; these are the only rows where it differs from the workbook.
  const KNOWN_QA_DISPLAY_DIFFERENCES = [21, 26, 33, 41, 42, 44, 45, 46, 47];
  it("derives QA flags, differing from the workbook's typed text only on the known rows", () => {
    const diff = wb.excelRows.filter((r, i) => rows[i]!.qaFlag !== cv(wb, "Resource Build-Up", `AI${r}`));
    expect(diff).toEqual(KNOWN_QA_DISPLAY_DIFFERENCES);
    const blocking = new Set(["RESOURCE CODE", "RATE MISSING", "OPERATOR DOUBLE-COUNT", "FUEL DOUBLE-COUNT"]);
    expect(rows.some((r) => blocking.has(r.qaFlag))).toBe(false);
    // rows shown OK in the workbook but not marked Verified are surfaced as VERIFY by the engine
    const surfaced = wb.excelRows.filter((r, i) => rows[i]!.qaFlag === "VERIFY" && cv(wb, "Resource Build-Up", `AI${r}`) === "OK");
    for (const r of [21, 44, 45]) expect(surfaced).toContain(r);
  });

  it("matches QS item amounts and the total direct cost", () => {
    const amounts = new Map<string, unknown>();
    for (let r = 3; r < 41; r++) {
      const code = cv(wb, "QS Takeoff", `B${r}`);
      if (code) amounts.set(String(code), cv(wb, "QS Takeoff", `G${r}`));
    }
    for (const line of qs.lines) expect(near(line.amount, amounts.get(line.code)), line.code).toBe(true);
    expect(c2(qs.totalDirect)).toBe("435521.88");
    expect(qs.orphanCost.isZero()).toBe(true);
  });

  it("matches the section totals", () => {
    const expected: Record<string, string> = {
      "Preliminaries & General": "48403.40", "Erosion & Sediment Control": "7750.14", Earthworks: "116065.18", "Pavements & Concrete": "119034.31",
      "Kerbs, Channels & External Sitework": "65000.00", "Retaining Walls": "71668.84", "Testing, As-Builts & Compliance": "4600.00", "Reinstatement & Handover": "3000.00",
    };
    const got = Object.fromEntries([...qs.sectionTotals].map(([k, v]) => [k, cents(v).toFixed(2)]));
    expect(got).toEqual(expected);
  });

  it("matches the weather allowance (CA10)", () => {
    expect(c2(weather.exposedPool)).toBe("54070.63");
    expect(c2(weather.directProductivity)).toBe("12458.56");
    expect(c2(weather.criticalPathPrelims)).toBe("5156.13");
    expect(c2(weather.billedHire)).toBe("590");
    expect(c2(weather.allowance)).toBe("18204.69");
    expect(near(weather.allowance, cv(wb, "Weather Risk", "B38"))).toBe(true);
  });

  it("matches the tender build-up chain", () => {
    expect(c2(tender.baseDirect)).toBe("435521.88");
    expect(c2(tender.additions.get("CA09")!)).toBe("3000");
    expect(c2(tender.additions.get("CA10")!)).toBe("18204.69");
    expect(c2(tender.additions.get("CA16")!)).toBe("18269.06");
    expect(c2(tender.preMarginTotal)).toBe("39473.75");
    expect(c2(tender.subtotal)).toBe("474995.63");
    expect(c2(tender.overhead)).toBe("47499.56");
    expect(c2(tender.profit)).toBe("92205.03");
    expect(c2(tender.tenderExclGst)).toBe("614700.22");
    expect(tender.gst.isZero()).toBe(true);
  });

  it("matches every cached cell of the Tender Build-Up sheet", () => {
    const pairs: Record<string, Dec> = { B20: tender.baseDirect, B39: tender.preMarginTotal, B40: tender.subtotal, B42: tender.overhead, B43: tender.profit, B46: tender.commercialTotal, B47: tender.tenderExclGst };
    for (const [cell, v] of Object.entries(pairs)) expect(near(v, cv(wb, "Tender Build-Up", cell)), cell).toBe(true);
  });

  it("matches the consolidated package and margin", () => {
    expect(c2(cons.overlaysTotal)).toBe("473076.45"); // Coast 210,606.00 + Allied 262,470.45
    expect(c2(cons.grossKnownPackage)).toBe("948072.08");
    expect(c2(cons.overhead)).toBe("94807.21");
    expect(c2(cons.profit)).toBe("184037.52");
    expect(c2(cons.allInTender)).toBe("1226916.81");
    expect(s(cons.grossMarginOnSell.times(100).toDecimalPlaces(2))).toBe("22.73");
    expect(near(cons.allInTender, cv(wb, "Consolidated Package", "F56"))).toBe(true);
    expect(near(cons.grossKnownPackage, cv(wb, "Consolidated Package", "B12"))).toBe(true);
  });

  it("reconciles the Allied allocation and keeps the management reserve fixed", () => {
    const allied = wb.overlays.filter((o) => o.name.startsWith("Allied")).reduce((t, o) => t.plus(d(o.amount)), ZERO);
    expect(c2(allied)).toBe("262470.45");
    expect(near(allied, cv(wb, "Consolidated Package", "B11"), "0.005")).toBe(true);
    const reserve = d(cv(wb, "Commercial Inputs", "E20") as number);
    const base = d(cv(wb, "Commercial Inputs", "B34") as number);
    expect(c2(reserve)).toBe("18269.06");
    expect(near(base.times("0.04"), reserve)).toBe(true);
  });

  it("assembles an estimate that reconciles with the workbook everywhere", () => {
    const est = computeTenderEstimate(wb);
    expect(est.reconciliation.filter((r) => !r.ok)).toEqual([]);
    expect(est.reconciled).toBe(true);
    expect(Number(cents(est.summary.allIn).toString())).toBe(1226916.81);
    expect(est.qs.lines.length).toBe(30);
    expect(est.rows.length).toBe(64);
    expect(wb.meta.project?.startsWith("329 Hobsonville Road")).toBe(true);
  });

  it("reads and checks Risk Truth, the reserve and the programme from the workbook", () => {
    const est = computeTenderEstimate(wb);
    expect(wb.riskTruth!.length).toBe(15);
    expect(wb.riskTruth!.slice(0, 3).map((x) => x.ref)).toEqual(["RT01-001", "RT02-001", "RT03-001"]);
    // row RT01-001 is shifted one column right in the workbook; the importer still reads mode / quantity / evidence correctly
    const x = wb.riskTruth!.find((e) => e.ref === "RT01-001")!;
    expect([x.mode, x.qty, x.unit, x.evidence, x.cost_ref]).toEqual(["RFI Hold", "274", "m3", "RED", "EW08/EW09/EW10"]);
    // the workbook's own gate cell counts 3 RED exposures (the shifted row is missed); the platform counts all 4
    expect([est.riskTruth.redRisks, est.riskTruth.redExposures, est.riskTruth.amberExposures]).toEqual([4, 4, 11]);
    expect(est.riskTruth.gate.startsWith("HOLD")).toBe(true);
    expect(est.riskTruth.ca01.isZero() && est.riskTruth.ca02.isZero()).toBe(true);
    expect(est.riskTruth.duplicateGate).toBe("OK");

    expect(wb.managementReserve!.selected.startsWith("18269.06")).toBe(true);
    expect(wb.managementReserve!.selected_basis).toContain("Rick Jones approved 4.0%");
    const r = est.reserve!;
    expect(Math.abs(Number(r.selectedSell!.toString()) - 23642.32)).toBeLessThan(0.01);
    expect(r.status).toBe("AMBER");
    expect(r.position).toBeNull();
    // the four red items from the workbook's own adjudication block; no probabilities are invented
    expect(r.items.length).toBe(4);
    expect(wb.managementReserve!.items.map((i) => i.title)).toEqual(["Earthworks (red item)", "Ramp/stairs (red item)", "Retaining (red item)", "PV01 productivity (red item)"]);
    expect(wb.managementReserve!.items.every((i) => i.prob_status === "UNKNOWN")).toBe(true);
    expect([r.weightedHigh.toString(), r.unknownItems, r.unquantifiedItems]).toEqual(["0", 2, 1]);

    const p = est.programme as { duration: number; finish: string | null; problems: string[]; criticalPath: string[]; tasks: { code: string; duration: number; derived: number | null; hammock: boolean; critical: boolean; qs_code: string }[] };
    expect([p.duration, p.finish, p.problems]).toEqual([55, "2026-12-16", []]);
    expect(p.criticalPath).toEqual(["ESC01", "EW01", "PRG-RF01", "EW03", "ES01", "PRG-PROOF", "PV01", "PRG-CURE", "PV05", "RH01"]);
    const by = Object.fromEntries(p.tasks.map((t) => [t.code, t]));
    expect([by.PG01!.hammock, by.PG01!.duration, by.PG01!.critical]).toEqual([true, 55, false]);
    expect([by.PV01!.derived, by.PV01!.duration, by.ESC01!.derived, by.ESC01!.duration]).toEqual([20, 10, 2, 3]); // override beats derived
    expect([by.EW06!.duration, by.EW09!.duration, by["DRN-REF01"]!.duration, by["PRG-RF01"]!.qs_code]).toEqual([0, 9, 21, ""]);
  });
});

describe.runIf(!present)("Hobsonville Rev34E golden test", () => {
  it.skip("skipped: private/Rev34E.xlsx is not present", () => {});
});
