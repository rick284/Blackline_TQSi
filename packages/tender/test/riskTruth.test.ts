/** Risk Truth vs the approved Master Estimate Workbook's own formulas (QSi Pro golden fixture, recalculated in LibreOffice). */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { D } from "@blackline/engine";
import { riskTruth as rt } from "../src/index.js";

interface Scenario {
  items: Record<string, unknown>[];
  risk_rags: string[];
  expected: {
    rows: { modelled: unknown; addition: unknown; duplication: string; status: string }[];
    ca01: unknown; ca02: unknown; red_risks: number; red_exposures: number; duplicate_gate: string; programme_gate: string; gate: string;
  };
}

const GOLD: Scenario[] = JSON.parse(readFileSync(new URL("./fixtures/golden_risk_truth.json", import.meta.url), "utf8")).scenarios;
const BLANK = Object.fromEntries(rt.FIELDS.map((f) => [f, ""]));
const s = (x: { toString(): string } | null) => (x === null ? null : x.toString());

const itemsOf = (sc: Scenario): rt.Exposure[] =>
  sc.items.map((it, i) => ({
    id: `X-${String(i).padStart(4, "0")}`, ...BLANK,
    ...Object.fromEntries(Object.entries(it).map(([k, v]) => [k, v === null || v === undefined ? "" : String(v)])),
  })) as rt.Exposure[];

const item = (o: Partial<Record<rt.Field, string>> = {}): rt.Exposure =>
  ({ id: "X-0001", ...BLANK, include: "No", evidence: "GREEN", mode: "Already in Base / No Add", ...o }) as rt.Exposure;

describe("matches the workbook", () => {
  GOLD.forEach((sc, i) => {
    it(`scenario ${i}`, () => {
      const exp = sc.expected;
      const res = rt.computeRiskTruth(itemsOf(sc), sc.risk_rags.map((rag) => ({ rag })), exp.programme_gate === "OK");
      res.exposures.forEach((o, j) => {
        const e = exp.rows[j]!;
        const em = e.modelled;
        if (em === null || em === "" || em === undefined) expect(o.modelled, `row ${j}`).toBeNull();
        else expect(o.modelled!.eq(new D(String(em))), `row ${j} modelled ${o.modelled} vs ${em}`).toBe(true);
        expect(o.addition.eq(new D(String(e.addition || 0))), `row ${j} addition`).toBe(true);
        expect(o.duplication, `row ${j}`).toBe(e.duplication);
        expect(o.workbookStatus, `row ${j}`).toBe(e.status);
      });
      expect(res.ca01.eq(new D(String(exp.ca01 || 0)))).toBe(true);
      expect(res.ca02.eq(new D(String(exp.ca02 || 0)))).toBe(true);
      expect(res.redRisks).toBe(exp.red_risks);
      expect(res.redExposuresWorkbook).toBe(exp.red_exposures);
      expect(res.duplicateGate).toBe(exp.duplicate_gate);
      expect(res.gateWorkbook).toBe(exp.gate);
    });
  });

  it("the golden set covers the interesting cases", () => {
    const rows = GOLD.flatMap((sc) => sc.expected.rows);
    expect(rows.length).toBeGreaterThan(150);
    const dups = new Set(rows.map((r) => r.duplication));
    for (const d of ["OK", "RED - RESIDUAL NOT DISTINCT", "RED - UNDECLARED OVERLAP", "DECLARED OVERLAP"]) expect(dups.has(d)).toBe(true);
    expect(new Set(rows.map((r) => r.status))).toEqual(new Set(["RED", "AMBER", "GREEN"]));
    expect(new Set(GOLD.map((sc) => sc.expected.gate))).toEqual(new Set(["PASS", "HOLD - RED ITEMS / INTEGRATION CHECK"]));
  });
});

describe("platform differences from the workbook", () => {
  it("treats blank evidence as RED", () => {
    const r = rt.computeRiskTruth([item({ evidence: "" })]).exposures[0]!;
    expect(r.status).toBe("RED");
    expect(r.workbookStatus).toBe("GREEN");
    expect(r.reasons).toContain("No evidence status recorded");
  });
  it("flags a provision that would be silently dropped", () => {
    const r = rt.computeRiskTruth([item({ mode: "Fixed Allowance", provision: "1000", include: "Yes", distinct: "Yes", target: "PV01 direct QS", integration_complete: "Yes" })]);
    expect(r.exposures[0]!.status).toBe("RED");
    expect(r.ca01.isZero() && r.ca02.isZero()).toBe(true);
  });
  it("holds the platform gate until integration is marked complete", () => {
    const base = { mode: "Fixed Allowance", provision: "1000", include: "Yes", distinct: "Yes", target: "CA02" } as const;
    const r = rt.computeRiskTruth([item(base)]);
    expect(s(r.ca02)).toBe("1000");
    expect(r.gateWorkbook).toBe("PASS");
    expect(r.gate.startsWith("HOLD")).toBe(true);
    expect(r.issues.length).toBeGreaterThan(0);
    const done = rt.computeRiskTruth([item({ ...base, integration_complete: "Yes" })]);
    expect(done.gate).toBe("PASS");
    expect(s(done.ca02)).toBe("1000");
  });
});

describe("validation", () => {
  it("builds items, numbers refs and rejects bad input", () => {
    const it1 = rt.buildItem("X-abc123", { risk_id: "RT05", consequence: "Allproof quantity", mode: "Probability x Impact", probability: "0.6", unit_rate: "9500" }, []);
    expect(it1.ref).toBe("RT05-001");
    expect(it1.include).toBe("No");
    expect(rt.buildItem("X-abc124", { risk_id: "RT05", consequence: "again" }, [it1]).ref).toBe("RT05-002");
    for (const [field, bad] of [["probability", "60"], ["probability", "-0.1"], ["provision", "-5"], ["provision", "abc"], ["mode", "Guess"], ["owner", "Boss"], ["include", "Maybe"], ["evidence", "PINK"]] as const)
      expect(() => rt.setField({ ...it1 }, field, bad), `${field}=${bad}`).toThrow(rt.RiskTruthError);
    expect(() => rt.buildItem("X-abc125", { risk_id: "RT05" }, [])).toThrow(rt.RiskTruthError);
    expect(s(rt.computeRiskTruth([it1]).exposures[0]!.modelled)).toBe("5700"); // modelled, but NOT added: include is No
    expect(rt.computeRiskTruth([it1]).ca02.isZero()).toBe(true);
  });
});
