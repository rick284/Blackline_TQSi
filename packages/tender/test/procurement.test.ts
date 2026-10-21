import { describe, expect, it } from "vitest";
import { assembleInputs, computeTenderEstimate, splitIntoPackages, type TenderInputs } from "../src/index.js";
import * as P from "../src/procurement.js";
import { gates } from "../src/submission.js";
import type { Quote } from "../src/quotes.js";

const quote = (ref: string, o: Partial<Quote> = {}): Quote => ({
  id: ref, ref, package: "Drainage", supplier: "Allied", estimate_ref: "", qty: "", unit: "", amount: "100000", scope: "", documents: "", status: "", action: "", notes: "", treatment: "", verification: "", source: "", quote_date: "", valid_until: "", ...o,
});
const pkg = (o: Partial<P.ProcPackage> = {}): P.ProcPackage & { seq: number } => ({ id: "P1", name: "Drainage", overlay: "Drainage", scope: "", selected: "", reason: "", by: "", at: "", seq: 1000, ...o });

describe("packages and invites", () => {
  it("names a package once and keeps a link to the subcontract package", () => {
    expect(P.buildPackage("P2", { name: "Concrete", overlay: "Concrete sub" }, [{ name: "Drainage" }])).toMatchObject({ name: "Concrete", overlay: "Concrete sub", selected: "" });
    expect(() => P.buildPackage("P2", { name: "drainage" }, [{ name: "Drainage" }])).toThrow("already a package");
    expect(() => P.buildPackage("P2", { name: " " }, [])).toThrow("Name the package");
  });
  it("records who was asked, when, and moves through the answers", () => {
    const i = P.buildInvite("I1", "P1", { supplier: "Allied Drainage", sent: "2026-10-20", due: "2026-10-30" });
    expect(i).toMatchObject({ status: "invited", sent: "2026-10-20", due: "2026-10-30" });
    expect(P.setInviteField(i, "status", "quoted").status).toBe("quoted");
    expect(() => P.setInviteField(i, "status", "maybe")).toThrow("Status must be");
    expect(() => P.setInviteField(i, "due", "2026-02-30")).toThrow("real date");
    expect(() => P.buildInvite("I2", "P1", { supplier: " " })).toThrow("Say who");
  });
});

describe("levelling", () => {
  it("adds adjustments (a saving may be negative) and works the exclusions out one at a time", () => {
    let l = P.blankLevel("Q-01");
    l = P.addAdjustment(l, { label: "Add: traffic management", amount: "$4,500.50" });
    l = P.addAdjustment(l, { label: "Less: spoil removal they include", amount: "-1200" });
    expect(l.adjustments.map((a) => a.amount)).toEqual(["4500.5", "-1200"]);
    expect(() => P.addAdjustment(l, { label: "", amount: "1" })).toThrow("Say what the adjustment");
    expect(() => P.addAdjustment(l, { label: "x", amount: "lots" })).toThrow("needs a number");
    l = P.addExclusion(l, "Rock excavation");
    expect(l.exclusions[0]).toEqual({ text: "Rock excavation", treatment: "", note: "" });
    l = P.setExclusion(l, 0, "treatment", "by others");
    expect(l.exclusions[0]!.treatment).toBe("by others");
    expect(() => P.setExclusion(l, 0, "treatment", "ignore it")).toThrow("Treatment must be");
    expect(P.removeAdjustment(l, 0).adjustments).toHaveLength(1);
    expect(P.removeExclusion(l, 0).exclusions).toHaveLength(0);
  });
  it("selecting needs a reason, and clearing wipes it", () => {
    const p = P.select(pkg(), "Q-02", "Lowest like for like and includes the traffic management", "Eli", "2026-10-25T00:00:00Z");
    expect(p).toMatchObject({ selected: "Q-02", by: "Eli" });
    expect(() => P.select(pkg(), "Q-02", " ", "Eli", "")).toThrow("Say why");
    expect(P.select(p, "", "", "", "")).toMatchObject({ selected: "", reason: "", by: "" });
  });
});

describe("comparing quotes like for like", () => {
  const quotes = [quote("Q-01", { supplier: "Allied", amount: "100000", valid_until: "2026-12-01" }), quote("Q-02", { supplier: "Beta", amount: "95000" }), quote("Q-03", { supplier: "Gamma", amount: "" }), quote("Q-09", { package: "Pavement", amount: "5" })];
  const level = (quoteRef: string, adj: [string, string][], ex: [string, string][] = []): P.ProcLevel => ({ quoteRef, adjustments: adj.map(([label, amount]) => ({ label, amount })), exclusions: ex.map(([text, treatment]) => ({ text, treatment, note: "" })), note: "" });
  const input = (o: Partial<P.ProcInput> = {}): P.ProcInput => ({ packages: [pkg()], invites: [], levels: [], ...o });

  it("ranks by the levelled total, not the quoted one, and leaves out a quote with no amount", () => {
    const r = P.computeProcurement(input({ levels: [level("Q-02", [["Add: traffic management", "9000.50"]])] }), quotes, [{ name: "Drainage", amount: "100000" }]).packages[0]!;
    expect(r.bids.map((b) => [b.ref, b.levelled.toString(), b.rank, b.lowest])).toEqual([["Q-01", "100000", 1, true], ["Q-02", "104000.5", 2, false], ["Q-03", "0", null, false]]);
    expect(r.bids.find((b) => b.ref === "Q-09")).toBeUndefined(); // another package's quote
    expect(r.status).toBe("TO ADJUDICATE");
    expect(r.warnings).toContain("3 quotes received and none selected.");
  });

  it("equal levelled totals share a place", () => {
    const r = P.computeProcurement(input({ levels: [level("Q-02", [["Add", "5000"]])] }), quotes.slice(0, 2), []).packages[0]!;
    expect(r.bids.map((b) => b.rank)).toEqual([1, 1]);
  });

  it("holds a selected quote that still has an exclusion nobody has dealt with, and releases it once each is", () => {
    const sel = pkg({ selected: "Q-02", reason: "Lowest" });
    const open = P.computeProcurement(input({ packages: [sel], levels: [level("Q-02", [], [["Rock excavation", ""], ["Dewatering", "by others"]])] }), quotes, []);
    expect(open.packages[0]).toMatchObject({ status: "CHECK", problems: ["1 exclusion in Q-02 has not been dealt with."] });
    expect(open.blocking).toBe(1);
    expect(open.gate).toMatch(/^HOLD/);
    const done = P.computeProcurement(input({ packages: [sel], levels: [level("Q-02", [], [["Rock excavation", "own works"], ["Dewatering", "by others"]])] }), quotes, []);
    expect([done.packages[0]!.status, done.blocking, done.gate.slice(0, 4)]).toEqual(["SELECTED", 0, "PASS"]);
  });

  it("holds a selection that points at a quote no longer there, or one with no amount", () => {
    expect(P.computeProcurement(input({ packages: [pkg({ selected: "Q-77" })] }), quotes, []).packages[0]!.problems[0]).toContain("no longer in the quote register");
    expect(P.computeProcurement(input({ packages: [pkg({ selected: "Q-03" })] }), quotes, []).packages[0]!.problems).toContain("Q-03 has no amount.");
  });

  it("shows the difference from what the estimate carries, never changes it", () => {
    const sel = pkg({ selected: "Q-01" });
    const r = P.computeProcurement(input({ packages: [sel], levels: [level("Q-01", [["Add: allowance", "2500"]], [["Rock", "accepted risk"]])] }), quotes, [{ name: "Drainage", amount: "100000" }]);
    expect(r.packages[0]).toMatchObject({ status: "SELECTED" });
    expect([r.packages[0]!.estimate!.toString(), r.packages[0]!.variance!.toString(), r.differences]).toEqual(["100000", "2500", 1]);
    const same = P.computeProcurement(input({ packages: [sel] }), quotes, [{ name: "Drainage", amount: "100000" }]);
    expect([same.packages[0]!.variance!.toString(), same.differences]).toEqual(["0", 0]);
  });

  it("counts the answers to the invites", () => {
    const invites = [P.buildInvite("I1", "P1", { supplier: "A" }), { ...P.buildInvite("I2", "P1", { supplier: "B" }), status: "quoted" as const }, P.buildInvite("I3", "P2", { supplier: "C" })];
    expect(P.computeProcurement(input({ invites }), quotes, []).packages[0]!.inviteCounts).toEqual({ invited: 1, quoted: 1, declined: 0, "no-response": 0 });
  });

  it("says when a quote's validity runs out, against a given day", () => {
    expect(P.validity("2026-11-01", "2026-10-22")).toEqual({ state: "ok", days: 10 });
    expect(P.validity("2026-10-21", "2026-10-22")).toEqual({ state: "expired", days: -1 });
    expect(P.validity("", "2026-10-22").state).toBe("none");
  });
});

describe("procurement in the estimate", () => {
  const registerQuotes = [quote("Q-01", { amount: "5000" }), quote("Q-02", { amount: "4800", supplier: "Beta" }), quote("Q-03", { package: "Concrete sub", amount: "1" })];
  it("starts from the quote register: a package per name, linked to the subcontract package of the same name", () => {
    const p = P.procurementPackage(registerQuotes, [{ name: "Drainage" }]);
    expect([p.key, p.kind, Object.keys(p.records)]).toEqual(["procurement", "procurement", ["pp:P1", "pp:P2"]]);
    expect(p.records["pp:P1"]!.body).toMatchObject({ name: "Drainage", overlay: "Drainage" });
    expect(p.records["pp:P2"]!.body).toMatchObject({ name: "Concrete sub", overlay: "" });
  });

  const base: TenderInputs = {
    library: [{ code: "SUB", description: "Subcontract", unit: "ea", baseRate: "1" }],
    qs: [{ code: "EW01", section: "Earthworks", description: "Strip", unit: "m2", quantity: "100" }],
    rows: [{ qsCode: "EW01", mode: "Lump Sum / Quote", resourceType: "Subcontract", resourceCode: "SUB", manualQty: "1", jobRateOverride: "1000", verified: "Yes", uid: "EW01-001" }],
    weatherLinks: { dailyUid: "", hoursPerDay: 8, weeklyUids: [] }, tool: { exposedPool: 0, rainWetGroundCost: 0, criticalPathDelayWd: 0, additionalBilledWeeks: 0 },
    commercial: [{ ref: "CA17", name: "Overhead", method: "Markup %", include: "Yes", pct: "0.1", pcSum: "0" }], overlays: [{ name: "Drainage", amount: "5000" }], overlap: "0", reference: null,
    quotes: registerQuotes,
  };
  const withProc = (packages: P.ProcPackage[], levels: P.ProcLevel[] = []): TenderInputs => ({ ...base, procurement: { packages, invites: [], levels } });

  it("blocks issuing on a selected quote's open exclusions, and warns about the rest", () => {
    const e = computeTenderEstimate(withProc([pkg({ selected: "Q-02", reason: "Lowest" })], [{ quoteRef: "Q-02", adjustments: [], exclusions: [{ text: "Rock", treatment: "", note: "" }], note: "" }]));
    const g = gates(e);
    expect(g.blockers.find((b) => b.id === "procurement")).toMatchObject({ where: "procurement", count: 1 });
    expect(g.warnings.find((w) => w.id === "procurement-diff")).toBeDefined(); // 4,800 against the 5,000 the estimate carries
    expect(g.warnings.find((w) => w.id === "procurement-open")).toBeUndefined();
    const ok = gates(computeTenderEstimate(withProc([pkg({ selected: "Q-02", reason: "Lowest" })], [{ quoteRef: "Q-02", adjustments: [], exclusions: [{ text: "Rock", treatment: "by others", note: "" }], note: "" }])));
    expect(ok.blockers.some((b) => b.id === "procurement")).toBe(false);
    expect(gates(computeTenderEstimate(withProc([pkg()]))).warnings.find((w) => w.id === "procurement-open")).toMatchObject({ count: 1 });
  });

  it("is its own package, rebuilt exactly, and a job without one is unaffected", () => {
    expect(splitIntoPackages(withProc([pkg()])).some((p) => p.key === "procurement")).toBe(false);
    const recs = Object.entries(P.procurementPackage(registerQuotes, [{ name: "Drainage" }]).records).map(([id, data]) => ({ id, data }));
    expect(assembleInputs(recs).procurement!.packages.map((p) => p.name)).toEqual(["Drainage", "Concrete sub"]);
    const e = computeTenderEstimate(base);
    expect(e.procurement).toMatchObject({ blocking: 0, toAdjudicate: 0, packages: [] });
    expect(gates(e).blockers.some((b) => b.id === "procurement")).toBe(false);
  });
});
