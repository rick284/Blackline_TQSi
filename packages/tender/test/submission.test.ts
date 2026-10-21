import { describe, expect, it } from "vitest";
import { computeTenderEstimate, type TenderInputs } from "../src/estimate.js";
import { diffEstimates } from "../src/diff.js";
import * as S from "../src/submission.js";

const reg = (kind: string, ref: string, title: string, status = ""): any => ({ id: `R-${ref}`, kind, ref, title, detail: "", action: "", status, rag: "", owner: "", likelihood: "", impact: "", rating: "" });
const scopeItem = (over: Record<string, string> = {}): any => ({ id: "S1", ref: "SC-001", group: "Permanent works", title: "Earthworks", detail: "", source: "", owner: "OWN WORKS", treatment: "PRICED", cost_refs: "EW01, PV01", register_refs: "", quote_refs: "", basis: "", action: "", ...over });

describe("the wording drafted from the register", () => {
  it("is the full text when the title is only the start of it (as an import leaves long items), and the title otherwise", () => {
    const full = "Ground exclusion: ".padEnd(300, "x") + " and the rest of the sentence that the title cut off.";
    const long = { ...reg("exclusion", "EX-01", full.slice(0, 300)), detail: full };
    const short = { ...reg("exclusion", "EX-02", "Foundations by others"), detail: "Notes for the estimator that are not for the client" };
    const q = S.qualificationsFrom([long, short]);
    expect(q[0]!.text).toBe(full);
    expect(q[1]!.text).toBe("Foundations by others");
  });
});

const base = (): TenderInputs => ({
  library: [{ code: "SUB", description: "Subcontract", unit: "ea", baseRate: "1" }],
  qs: [
    { code: "EW01", section: "Earthworks", description: "Bulk earthworks", unit: "m3", quantity: "1000" },
    { code: "PV01", section: "Pavements", description: "Basecourse", unit: "m2", quantity: "500" },
  ],
  rows: [
    { qsCode: "EW01", mode: "Lump Sum / Quote", resourceType: "Subcontract", resourceCode: "SUB", manualQty: "1", jobRateOverride: "10000", verified: "Yes", uid: "EW01-001", task: "Strip" },
    { qsCode: "PV01", mode: "Lump Sum / Quote", resourceType: "Subcontract", resourceCode: "SUB", manualQty: "1", jobRateOverride: "4000", verified: "Yes", uid: "PV01-001", task: "Pave" },
  ],
  weatherLinks: { dailyUid: "", hoursPerDay: 8, weeklyUids: [] },
  tool: { exposedPool: 0, rainWetGroundCost: 0, criticalPathDelayWd: 0, additionalBilledWeeks: 0 },
  commercial: [
    { ref: "CA17", name: "Overhead", method: "Markup %", include: "Yes", pct: "0.1", pcSum: "0" },
    { ref: "CA18", name: "Profit", method: "Margin %", include: "Yes", pct: "0.15", pcSum: "0" },
  ],
  overlays: [{ name: "Concrete sub", amount: "5000" }], overlap: "0", reference: null, scope: [], register: [], quotes: [],
  programme: { start: "2026-10-05", days_per_week: 5, hours_per_day: 8, tasks: [{ id: "P-1", code: "EW01", name: "Strip", qs_code: "EW01", override_days: "3", predecessors: [], hammock: false, basis: "", note: "" }] },
});
const est = (i: TenderInputs) => computeTenderEstimate(i);
const ids = (g: S.Gate[]) => g.map((x) => x.id);

describe("what stops a tender issuing", () => {
  it("no scope recorded: blocked", () => {
    expect(ids(S.gates(est(base())).blockers)).toContain("scope-none");
  });
  it("scope items that are missing an owner or treatment, and priced items nothing covers: blocked, in plain words", () => {
    const i = base(); i.scope = [scopeItem({ owner: "", treatment: "", cost_refs: "EW01" })];
    const g = S.gates(est(i));
    expect(ids(g.blockers)).toEqual(expect.arrayContaining(["scope-missing", "scope-unhomed"]));
    expect(g.blockers.find((x) => x.id === "scope-unhomed")!.text).toContain("PV01");
    expect(g.blockers.every((x) => x.where === "scope")).toBe(true);
  });
  it("a scope item flagged to confirm blocks too (a subcontract item with no quote behind it)", () => {
    const i = base(); i.scope = [scopeItem({ owner: "SUBCONTRACT" })];
    expect(ids(S.gates(est(i)).blockers)).toContain("scope-check");
    i.quotes = [{ id: "Q1", ref: "Q-01", package: "Civil", supplier: "X", estimate_ref: "EW01", qty: "", unit: "", amount: "1", scope: "", documents: "", status: "", action: "", notes: "", treatment: "", verification: "", source: "", quote_date: "", valid_until: "" }];
    i.scope = [scopeItem({ owner: "SUBCONTRACT", quote_refs: "Q-01" })];
    expect(ids(S.gates(est(i)).blockers)).not.toContain("scope-check");
  });
  it("a build-up row with no rate blocks; a tender with everything backed up has no blockers", () => {
    const i = base(); i.scope = [scopeItem()];
    expect(S.gates(est(i)).blockers).toEqual([]);
    i.rows = [...i.rows, { qsCode: "PV01", mode: "Direct Qty", resourceType: "Labour", resourceCode: "NOPE", manualQty: "1", verified: "Yes", uid: "PV01-002" }];
    const g = S.gates(est(i));
    expect(ids(g.blockers)).toContain("rows");
    expect(g.blockers.find((x) => x.id === "rows")!.where).toBe("estimate");
  });
  it("warnings don't block", () => {
    const i = base(); i.scope = [scopeItem()]; i.programme = null;
    const g = S.gates(est(i));
    expect(g.blockers).toEqual([]);
    expect(ids(g.warnings)).toContain("programme");
  });
});

describe("labels, drafts and integrity", () => {
  it("labels revisions Rev A to Rev Z, then Rev AA", () => {
    expect([1, 2, 26, 27, 28, 52, 53].map(S.revisionLabel)).toEqual(["Rev A", "Rev B", "Rev Z", "Rev AA", "Rev AB", "Rev AZ", "Rev BA"]);
    expect(S.revisionLabel(0)).toBe("Rev A");
  });
  it("drafts qualifications from the register: exclusions, assumptions, inclusions, then open RFIs, closed ones left out", () => {
    const q = S.qualificationsFrom([reg("rfi", "RFI-01", "Confirm height", "OPEN"), reg("assumption", "A1", "Normal weekday access"), reg("exclusion", "EX-01", "Foundations by others"), reg("rfi", "RFI-02", "Done", "CLOSED"), reg("risk", "RT01", "A risk"), reg("document", "DOC-01", "Plans")]);
    expect(q.map((x) => [x.kind, x.ref, x.include])).toEqual([["exclusion", "EX-01", true], ["assumption", "A1", true], ["rfi", "RFI-01", false]]);
    expect(q[0]!.id).toBe("Q1");
  });
  it("gives the same text for the same records whatever order or key order, and different text when anything changes", () => {
    const a = [{ id: "b", data: { x: 1, y: { q: 1, p: 2 } } }, { id: "a", data: { z: [1, 2] } }];
    const b = [{ id: "a", data: { z: [1, 2] } }, { id: "b", data: { y: { p: 2, q: 1 }, x: 1 } }];
    expect(S.canonicalRecords(a)).toBe(S.canonicalRecords(b));
    expect(S.canonicalRecords(a)).not.toBe(S.canonicalRecords([{ id: "a", data: { z: [1, 3] } }, a[0]!]));
  });
  it("keeps the headline figures as exact text", () => {
    const t = S.headlineTotals(est(base()));
    expect(Object.keys(t)).toEqual(["allIn", "ownWorks", "knownCost", "baseDirect", "grossMarginOnSell"]);
    expect(t.baseDirect).toBe("14000");
    expect(Number(t.allIn)).toBeGreaterThan(Number(t.ownWorks));
  });
});

describe("setting two revisions side by side", () => {
  it("shows what moved: a quantity, a rate, a commercial line and a subcontract package", () => {
    const a = base();
    const b = base();
    b.rows[0] = { ...b.rows[0]!, jobRateOverride: "12000" };
    b.commercial[1] = { ...b.commercial[1]!, pct: "0.2" };
    b.overlays = [{ name: "Concrete sub", amount: "6000" }];
    const d = diffEstimates(S.displayOf(est(a), a), S.displayOf(est(b), b));
    expect(d.identical).toBe(false);
    expect(d.qs.map((x) => [x.code, x.kind, x.delta])).toEqual([["EW01", "changed", 2000]]);
    expect(d.buildup.map((x) => [x.row_id, x.task, x.resource])).toEqual([["EW01-001", "Strip", "SUB"]]);
    expect(d.overlays.map((x) => [x.name, x.delta])).toEqual([["Concrete sub", 1000]]);
    expect(d.settings.map((x) => x.key)).toEqual(["margin"]);
    expect(d.headline.find((h) => h.key === "all_in")!.delta).toBeGreaterThan(3000);
    const same = diffEstimates(S.displayOf(est(a), a), S.displayOf(est(base()), base()));
    expect(same.identical).toBe(true);
  });
});
