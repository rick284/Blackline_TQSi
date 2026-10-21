import { describe, expect, it } from "vitest";
import { procurement as P, splitIntoPackages, type TenderInputs } from "@blackline/tender/core";
import { addRecord, effectiveRecords, setRecord, type ServerRecord } from "../src/lib/draft.js";
import { levelId, newInvite, newPackage, validityText, writeLevel } from "../src/lib/procurement.js";
import { buildModel } from "../src/lib/model.js";

describe("procurement edits", () => {
  it("adds a package and an invite with the next free ids, and says what is wrong", () => {
    const pkgs: P.ProcPackage[] = [{ id: "P1", name: "Drainage", overlay: "", scope: "", selected: "", reason: "", by: "", at: "" }];
    expect(newPackage({ name: "Concrete" }, pkgs, 5000)).toMatchObject({ ok: true, recordId: "pp:P2" });
    expect(newPackage({ name: "drainage" }, pkgs, 1)).toMatchObject({ ok: false });
    expect(newInvite("P1", { supplier: "Allied", sent: "2026-10-22", due: "2026-10-30" }, [], 1)).toMatchObject({ ok: true, recordId: "pi:I1" });
    expect(newInvite("P1", { supplier: "", sent: "2026-10-22" }, [], 1)).toMatchObject({ ok: false });
    expect(newInvite("P1", { supplier: "A", sent: "2026-10-22", due: "soon" }, [], 1)).toMatchObject({ ok: false });
  });
  it("a quote's levelling is made the first time it is needed, keyed by the quote", () => {
    const r = writeLevel(undefined, "Q-01", (l) => P.addAdjustment(l, { label: "Add: traffic management", amount: "4500" }));
    expect(r).toMatchObject({ ok: true, recordId: levelId("Q-01"), data: { kind: "procLevel" } });
    expect(writeLevel(undefined, "Q-01", (l) => P.addAdjustment(l, { label: "", amount: "1" }))).toMatchObject({ ok: false });
  });
  it("words a quote's validity for the table", () => {
    expect(validityText("2026-10-24", "2026-10-22")).toEqual({ text: "2 days left", expired: false });
    expect(validityText("2026-10-22", "2026-10-22")).toEqual({ text: "Expires today", expired: false });
    expect(validityText("2026-10-20", "2026-10-22")).toEqual({ text: "Expired 2 days ago", expired: true });
    expect(validityText("", "2026-10-22")).toEqual({ text: "", expired: false });
  });
});

describe("procurement in the job model", () => {
  const quote = (ref: string, amount: string, supplier: string) => ({ id: ref, ref, package: "Concrete sub", supplier, estimate_ref: "", qty: "", unit: "", amount, scope: "", documents: "", status: "", action: "", notes: "", treatment: "", verification: "", source: "", quote_date: "", valid_until: "" });
  const inputs: TenderInputs = {
    library: [{ code: "SUB", description: "Subcontract", unit: "ea", baseRate: "1" }],
    qs: [{ code: "EW01", section: "Earthworks", description: "Strip", unit: "m2", quantity: "100" }],
    rows: [{ qsCode: "EW01", mode: "Lump Sum / Quote", resourceType: "Subcontract", resourceCode: "SUB", manualQty: "1", jobRateOverride: "1000", verified: "Yes", uid: "EW01-001" }],
    weatherLinks: { dailyUid: "", hoursPerDay: 8, weeklyUids: [] }, tool: { exposedPool: 0, rainWetGroundCost: 0, criticalPathDelayWd: 0, additionalBilledWeeks: 0 },
    commercial: [{ ref: "CA17", name: "Overhead", method: "Markup %", include: "Yes", pct: "0.1", pcSum: "0" }], overlays: [{ name: "Concrete sub", amount: "5000" }], overlap: "0", reference: null,
    quotes: [quote("Q-01", "5200", "Coast"), quote("Q-02", "4800", "Beta")],
  };
  const server: ServerRecord[] = [
    ...splitIntoPackages(inputs).flatMap((p, i) => Object.entries(p.records).map(([id, data]) => ({ id, packageId: `pkg-${i}`, data: JSON.parse(JSON.stringify(data)) }))),
    ...Object.entries(P.procurementPackage(inputs.quotes!, inputs.overlays).records).map(([id, data]) => ({ id, packageId: "pkg-proc", data: JSON.parse(JSON.stringify(data)) })),
  ];

  it("is empty until started, then has a package with its quotes to choose between", () => {
    expect(buildModel(server.filter((r) => r.packageId !== "pkg-proc")).procurementPackageId).toBe("");
    const m = buildModel(server);
    expect(m.procurementPackageId).toBe("pkg-proc");
    const p = m.estimate.procurement.packages[0]!;
    expect([p.name, p.status, p.bids.map((b) => [b.ref, b.rank])]).toEqual(["Concrete sub", "TO ADJUDICATE", [["Q-01", 2], ["Q-02", 1]]]); // in register order; the window sorts by place
    expect(m.gates.warnings.some((g) => g.id === "procurement-open")).toBe(true);
  });

  it("levelling and selecting in a draft move the ranking and the gates at once", () => {
    // Beta's lower quote leaves out traffic management; adding it puts Coast ahead
    const lev = writeLevel(undefined, "Q-02", (l) => P.addExclusion(P.addAdjustment(l, { label: "Add: traffic management", amount: "600" }), "Rock excavation"));
    if (!lev.ok) throw new Error(lev.error);
    let d = addRecord({}, "pkg-proc", lev.recordId, lev.data);
    const picked = P.select(buildModel(server).estimate.procurement.packages[0]! as unknown as P.ProcPackage, "Q-02", "Lowest levelled", "Eli", "2026-11-01T00:00:00Z");
    d = setRecord(d, server, "pkg-proc", "pp:P1", { kind: "procPackage", seq: 1000, body: { id: "P1", name: picked.name, overlay: picked.overlay, scope: "", selected: picked.selected, reason: picked.reason, by: picked.by, at: picked.at } });
    const m = buildModel(effectiveRecords(server, d));
    const p = m.estimate.procurement.packages[0]!;
    expect(p.bids.find((b) => b.ref === "Q-02")!.levelled.toString()).toBe("5400");
    expect([p.status, p.problems]).toEqual(["CHECK", ["1 exclusion in Q-02 has not been dealt with."]]);
    expect(m.gates.blockers.some((g) => g.id === "procurement")).toBe(true);
  });
});
