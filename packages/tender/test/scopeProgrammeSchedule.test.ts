/** Ported from QSi Pro engine/tests test_scope.py, test_programme.py and test_schedule.py (the parts that need no client files). */
import { describe, expect, it } from "vitest";
import { D } from "@blackline/engine";
import {
  autoMap, computeProgramme, computeSchedule, defaultSchedule, derivedDays, newProgramme, parseFormat, register, ScheduleError, scope as sc,
  validateSchedule, workingDate, type ProgrammeTask, type Schedule,
} from "../src/index.js";

const s = (x: { toString(): string } | null) => (x === null ? null : x.toString());

// ---- scope -----------------------------------------------------------------------------------------------------------
const COSTS = { EW01: 1000, EW02: 0, PV01: 5000, CA09: 3000 };
const BLANK = Object.fromEntries(sc.FIELDS.map((f) => [f, ""]));
const REG = [
  { ref: "A1", kind: "assumption", status: "" }, { ref: "EX-01", kind: "exclusion", status: "" },
  { ref: "RFI-01", kind: "rfi", status: "OPEN" }, { ref: "RFI-02", kind: "rfi", status: "CLOSED" },
] as register.RegisterItem[];
const item = (o: Partial<Record<(typeof sc.FIELDS)[number], string>> = {}): sc.ScopeItem => ({ id: "C-aaaaaa", ...BLANK, ref: "SC-001", title: "x", ...o }) as sc.ScopeItem;
const status = (o: Partial<Record<(typeof sc.FIELDS)[number], string>>) => {
  const r = sc.computeScope([item(o)], COSTS, REG, new Set(["Q-01"])).items[0]!;
  return [r.status, r.problems] as const;
};

describe("scope coverage", () => {
  it("requires each treatment to be backed up", () => {
    expect(status({ owner: "OWN WORKS", treatment: "PRICED", cost_refs: "EW01" })[0]).toBe("COMPLETE");
    let [st, p] = status({ owner: "OWN WORKS", treatment: "PRICED", cost_refs: "" });
    expect(st).toBe("MISSING"); expect(p[0]).toContain("no QS item");
    [st, p] = status({ owner: "OWN WORKS", treatment: "PRICED", cost_refs: "EW02" });
    expect(st).toBe("CHECK"); expect(p[0]).toContain("carries no cost");
    [st, p] = status({ owner: "OWN WORKS", treatment: "PRICED", cost_refs: "ZZ99" });
    expect(st).toBe("CHECK"); expect(p[0]).toContain("isn't in the estimate");
    expect(status({ owner: "OWN WORKS", treatment: "ALLOWANCE", cost_refs: "CA09", basis: "Rate x days", register_refs: "A1" })[0]).toBe("COMPLETE");
    expect(status({ owner: "OWN WORKS", treatment: "PC SUM", cost_refs: "CA09" })[0]).toBe("CHECK");
    expect(status({ owner: "OTHERS", treatment: "EXCLUDED", register_refs: "EX-01" })[0]).toBe("COMPLETE");
    expect(status({ owner: "OTHERS", treatment: "EXCLUDED", register_refs: "EX-01", cost_refs: "PV01" })[0]).toBe("CHECK");
    expect(status({ owner: "OTHERS", treatment: "BY OTHERS", register_refs: "A1" })[0]).toBe("COMPLETE");
    expect(status({ owner: "OWN WORKS", treatment: "BY OTHERS", register_refs: "A1" })[0]).toBe("CHECK");
    expect(status({ owner: "TBC", treatment: "UNRESOLVED", register_refs: "RFI-01" })[0]).toBe("CHECK");
    [st, p] = status({ owner: "OWN WORKS", treatment: "UNRESOLVED" });
    expect(st).toBe("MISSING"); expect(p[0]).toContain("raise one");
    expect(status({ owner: "OWN WORKS", treatment: "UNRESOLVED", register_refs: "RFI-02" })[1]).toEqual(["The RFI is closed: update the treatment."]);
    expect(status({ owner: "OWN WORKS", treatment: "" })[0]).toBe("MISSING");
    expect(status({ owner: "", treatment: "PRICED", cost_refs: "EW01" })[0]).toBe("MISSING");
    [st, p] = status({ owner: "SUBCONTRACT", treatment: "PRICED", cost_refs: "EW01" });
    expect(st).toBe("CHECK"); expect(p[0]).toContain("no quote");
    expect(status({ owner: "SUBCONTRACT", treatment: "PRICED", cost_refs: "EW01", quote_refs: "Q-01" })[0]).toBe("COMPLETE");
    expect(status({ owner: "OWN WORKS", treatment: "PRICED", cost_refs: "EW01", register_refs: "A9" })[0]).toBe("CHECK");
  });

  it("gate counts missing items and priced items with no scope home", () => {
    expect(sc.computeScope([], COSTS, REG, new Set()).gate.startsWith("NOT STARTED")).toBe(true);
    const ok = item({ owner: "OWN WORKS", treatment: "PRICED", cost_refs: "EW01" });
    let r = sc.computeScope([ok], COSTS, REG, new Set());
    expect(r.gate.startsWith("HOLD")).toBe(true);
    expect(r.unhomedQs).toEqual(["PV01"]);
    const both = item({ id: "C-bbbbbb", ref: "SC-002", owner: "OWN WORKS", treatment: "PRICED", cost_refs: "PV01" });
    r = sc.computeScope([ok, both], COSTS, REG, new Set());
    expect(r.gate.startsWith("PASS")).toBe(true);
    expect(r.counts).toEqual({ COMPLETE: 2, CHECK: 0, MISSING: 0, total: 2 });
    r = sc.computeScope([ok, both, item({ id: "C-cccccc", ref: "SC-003" })], COSTS, REG, new Set());
    expect(r.gate.startsWith("HOLD")).toBe(true);
    expect(r.counts.MISSING).toBe(1);
  });

  it("validates and normalises fields", () => {
    const it1 = sc.buildItem("C-dddddd", { title: "Silt fencing", group: "enabling works", owner: "own works", treatment: "priced", cost_refs: "esc01  ESC01, ew01" }, []);
    expect([it1.group, it1.owner, it1.treatment, it1.cost_refs, it1.ref]).toEqual(["Enabling works", "OWN WORKS", "PRICED", "ESC01, EW01", "SC-001"]);
    expect(() => sc.setField(it1, "treatment", "MAYBE")).toThrow(sc.ScopeError);
    expect(() => sc.setField(it1, "owner", "the client")).toThrow(sc.ScopeError);
    expect(() => sc.buildItem("C-eeeeee", { detail: "no title" }, [])).toThrow(sc.ScopeError);
    expect(() => sc.buildItem("C-ffffff", { title: "dup", ref: "SC-001" }, [it1])).toThrow(sc.ScopeError);
  });
});

// ---- register ---------------------------------------------------------------------------------------------------------
describe("register", () => {
  it("numbers references per kind and summarises RFIs", () => {
    const a = register.buildItem("R-aaaaaa", { kind: "rfi", title: "Clash at gridline 4", rag: "red" }, []);
    expect([a.ref, a.status, a.rag]).toEqual(["RFI-01", "OPEN", "RED"]);
    const b = register.buildItem("R-bbbbbb", { kind: "assumption", title: "Rock not expected" }, [a]);
    expect(b.ref).toBe("A1");
    const c = register.buildItem("R-cccccc", { kind: "rfi", title: "Second" }, [a, b]);
    expect(c.ref).toBe("RFI-02");
    expect(register.statusSummary([a, b, c])).toEqual({ rfis: 2, openRfis: 2, openRedRfis: 1, redRisks: 0 });
    expect(() => register.buildItem("R-dddddd", { kind: "nonsense", title: "x" }, [])).toThrow(register.RegisterError);
    expect(() => register.buildItem("R-eeeeee", { kind: "rfi" }, [])).toThrow(register.RegisterError);
  });
});

// ---- programme --------------------------------------------------------------------------------------------------------
const T = (code: string, preds: string[] = [], days: number | null = null, ham = false, qs = ""): ProgrammeTask => ({
  id: `P-${code}xxx`, code, name: code, qs_code: qs, override_days: days === null ? null : String(days), predecessors: preds, hammock: ham, basis: "", note: "",
});

describe("programme", () => {
  it("rounds derived durations up to working days", () => {
    expect([derivedDays(new D("26.3125")), derivedDays(new D("16")), derivedDays(new D("16.01")), derivedDays(new D(0)), derivedDays(null)]).toEqual([4, 2, 3, null, null]);
    expect(derivedDays(new D("20"), 10)).toBe(2);
  });

  it("skips weekends and rolls a weekend start", () => {
    const d = (y: number, m: number, day: number) => new Date(Date.UTC(y, m - 1, day));
    const iso = (x: Date) => x.toISOString().slice(0, 10);
    expect(iso(workingDate(d(2026, 10, 1), 0))).toBe("2026-10-01");
    expect(iso(workingDate(d(2026, 10, 1), 3))).toBe("2026-10-06");
    expect(iso(workingDate(d(2026, 10, 3), 0))).toBe("2026-10-05");
    expect(iso(workingDate(d(2026, 10, 1), 3, 6))).toBe("2026-10-05");
  });

  it("finds the critical path, float, hammocks and problems", () => {
    const p = newProgramme("2026-10-01");
    p.tasks = [T("A", [], 3), T("B", ["A"], 4), T("C", ["A"], 1), T("D", ["B", "C"], 2), T("PG", [], 9, true)];
    const r = computeProgramme(p, new Map(), {});
    expect(r.duration).toBe(9);
    expect(r.criticalPath).toEqual(["A", "B", "D"]);
    expect(r.finish).toBe("2026-10-13");
    expect(r.problems).toEqual([]);
    expect(Object.fromEntries(r.tasks.map((t) => [t.code, t.float]))).toEqual({ A: 0, B: 0, C: 3, D: 0, PG: 0 });
    p.tasks[4]!.override_days = "12";
    expect(computeProgramme(p, new Map(), {}).problems.some((x) => x.includes("Preliminaries run 12 days"))).toBe(true);
    p.tasks[0]!.predecessors = ["Z"];
    expect(computeProgramme(p, new Map(), {}).problems.some((x) => x.includes("isn't in the programme"))).toBe(true);
    const q = newProgramme("");
    q.tasks = [T("A", ["B"], 1), T("B", ["A"], 1)];
    expect(computeProgramme(q, new Map(), {}).problems.some((x) => x.includes("loop"))).toBe(true);
  });

  it("takes duration from the slowest resource row unless overridden", () => {
    const p = newProgramme("");
    p.tasks = [T("EW01", [], null, false, "EW01"), T("EW02", [], 7, false, "EW02")];
    const info = { EW01: { section: "Earthworks", description: "d", amount: 1 }, EW02: { section: "Earthworks", description: "d", amount: 1 } };
    const r = computeProgramme(p, new Map([["EW01", new D("26.3125")], ["EW02", new D("100")]]), info);
    expect(r.tasks.map((t) => t.duration)).toEqual([4, 7]);
    expect(r.tasks.map((t) => t.derived)).toEqual([4, 13]);
  });
});

// ---- price schedule ---------------------------------------------------------------------------------------------------
const L = (ref: string, trade: string, kind = "work") => ({ ref, trade, kind });
const src = (key: string, amount: string, own = true) => ({ key, label: key, amount, own });
const rates = { overheadRate: "0.10", margin: "0.15" };

describe("price schedule", () => {
  it("reconciles exactly and the Margin line carries overhead and profit", () => {
    const sched: Schedule = { groups: [{ id: "g", name: "G", lines: [L("1", "Earthworks"), L("2", "Prelims", "pg"), L("3", "Margin", "margin")] }], map: { "qs:A": "line:1", "qs:B": "line:2" } };
    const r = computeSchedule(sched, [src("qs:A", "1000"), src("qs:B", "200")], new D(1200).times("1.1").div("0.85"), rates);
    const g = r.groups[0]!;
    expect(s(g.subtotal)).toBe("1000");
    expect(s(g.lines[1]!.amount)).toBe("200");
    expect(s(g.total)).toBe("1552.94");
    expect(s(g.lines[2]!.amount)).toBe("352.94");
    expect(r.reconciles).toBe(true);
    expect(r.difference.isZero()).toBe(true);
  });

  it("reports unmapped sources and bad targets", () => {
    const sched: Schedule = { groups: [{ id: "g", name: "G", lines: [L("1", "W"), L("2", "M", "margin")] }], map: { "qs:A": "line:1", "qs:C": "line:9" } };
    const r = computeSchedule(sched, [src("qs:A", "100"), src("qs:B", "50"), src("qs:C", "25")], new D(175), { overheadRate: 0, margin: 0 });
    expect(r.reconciles).toBe(false);
    expect(new Set(r.unmapped.map((u) => u.key))).toEqual(new Set(["qs:B", "qs:C"]));
    expect(r.problems.length).toBeGreaterThan(0);
  });

  it("splits into parts with a remainder", () => {
    const sched: Schedule = { groups: [{ id: "g", name: "G", lines: [L("1", "A"), L("2", "B"), L("3", "M", "margin")] }], map: { "overlay:X": [{ to: "line:1", amount: "30" }, { to: "line:2" }] } };
    const zero = { overheadRate: 0, margin: 0 };
    const r = computeSchedule(sched, [src("overlay:X", "100", false)], new D(100), zero);
    expect(r.groups[0]!.lines.slice(0, 2).map((x) => s(x.amount))).toEqual(["30", "70"]);
    expect(r.reconciles).toBe(true);
    sched.map!["overlay:X"] = [{ to: "line:1", amount: "130" }];
    expect(computeSchedule(sched, [src("overlay:X", "100", false)], new D(100), zero).problems.length).toBeGreaterThan(0);
  });

  it("validates its structure", () => {
    expect(() => validateSchedule({ groups: [] })).toThrow(ScheduleError);
    expect(() => validateSchedule({ groups: [{ id: "g", name: "G", lines: [L("1", "W")] }] })).toThrow(ScheduleError);
    expect(() => validateSchedule({ groups: [{ id: "g", name: "G", lines: [L("1", "W"), L("1", "X"), L("2", "M", "margin")] }] })).toThrow(ScheduleError);
  });

  it("spreads a cost by own-works weight inside the Margin lines", () => {
    const sched: Schedule = {
      groups: [{ id: "a", name: "A", lines: [L("1", "W"), L("2", "M", "margin")] }, { id: "b", name: "B", lines: [L("3", "W"), L("4", "M", "margin")] }],
      map: { "qs:A": "line:1", "qs:B": "line:3", "ca:CA16": "spread", "overlay:S": "line:3" },
    };
    const r = computeSchedule(sched, [src("qs:A", "100"), src("qs:B", "300"), src("ca:CA16", "40"), src("overlay:S", "500", false)], new D(940), { overheadRate: 0, margin: 0 });
    const [a, b] = r.groups;
    expect([s(a!.hidden), s(b!.hidden)]).toEqual(["10", "30"]); // 40 shared 100:300; the overlay doesn't count as own works
    expect([s(a!.total), s(b!.total)]).toEqual(["110", "830"]);
    expect(r.reconciles).toBe(true);
  });

  it("the default schedule for any estimate reconciles", () => {
    const sched = defaultSchedule(["Earthworks", "Pavements"], ["Coast Concrete"]);
    sched.map = autoMap(sched, [{ code: "EW01", section: "Earthworks" }, { code: "PV01", section: "Pavements" }], [{ name: "Coast Concrete" }], ["CA10"]);
    const r = computeSchedule(
      sched,
      [src("qs:EW01", "100"), src("qs:PV01", "200"), src("overlay:Coast Concrete", "300", false), src("ca:CA10", "50")],
      new D(650).times("1.1").div("0.85"),
      { overheadRate: "0.1", margin: "0.15" },
    );
    expect(r.reconciles).toBe(true);
    expect(r.groups[0]!.lines.length).toBe(5);
  });

  it("parses a client format from pasted text", () => {
    const TPW = `
# MAIN BUILDING | A
MB/001\tExcavation
MB/002\tConcrete
MB/003\tReinforcing
MB/004  Structural Steel
MB/025  Preliminaries & General   [pg]
MB/026  Margin   [margin]
# CIVIL WORKS | B
CW/001  Site Preparation/Silt Fencing
CW/002  Site Clearance/Demolition
CW/003  Retaining Walls
CW/004  Bulk Earthworks
CW/005  Stormwater Drainage
CW/006  Wastewater Drainage
CW/007  Water Supply
CW/008  Services Trenching
CW/009  Driveways/Car Parking/Vehicle Crossing/Pavements
CW/010  Planting/Soft Landscaping
CW/011  Fencing/Street Furniture
CW/012  Preliminaries & General  [pg]
CW/013  Margin  [margin]
`;
    const f = parseFormat(TPW, "TPW", "HLC PROPERTY LIMITED");
    expect(f.groups.map((g) => g.name)).toEqual(["MAIN BUILDING", "CIVIL WORKS"]);
    expect(f.groups[0]!.code).toBe("A");
    expect(f.groups[1]!.lines.slice(-2).map((x) => x.kind)).toEqual(["pg", "margin"]);
    expect(f.groups[1]!.lines.length).toBe(13);
    expect(parseFormat("# WORKS | W\n1  Earthworks\n2  Pavements").groups[0]!.lines.at(-1)).toEqual({ ref: "W/M", trade: "Margin", kind: "margin" });
    for (const bad of ["", "1  No heading", "# G\n1", "# G\n1  A\n1  B", "# G\n1  A [margin]\n2  B [margin]", "# \n1  A"]) expect(() => parseFormat(bad), JSON.stringify(bad)).toThrow(ScheduleError);
  });
});
