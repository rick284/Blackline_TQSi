import { describe, expect, it } from "vitest";
import { splitIntoPackages, type TenderInputs } from "@blackline/tender/core";
import { addRecord, editRecord, effectiveRecords, type Drafts, type ServerRecord } from "../src/lib/draft.js";
import { buildModel } from "../src/lib/model.js";
import { canDeleteLine, editableFields, newAllowance, newOverlay, parseOverlap, parsePercent, parseSum, setCaField, setOverlayField, type CaBody } from "../src/lib/commercial.js";

const inputs: TenderInputs = {
  library: [{ code: "SUB", description: "Subcontract", unit: "ea", baseRate: "1" }],
  qs: [{ code: "EW01", section: "Earthworks", description: "Bulk earthworks", unit: "m3", quantity: "1000" }],
  rows: [{ qsCode: "EW01", mode: "Lump Sum / Quote", resourceType: "Subcontract", resourceCode: "SUB", manualQty: "1", jobRateOverride: "10000", verified: "Yes", uid: "EW01-001" }],
  weatherLinks: { dailyUid: "", hoursPerDay: 8, weeklyUids: [] },
  tool: { exposedPool: 0, rainWetGroundCost: 0, criticalPathDelayWd: 0, additionalBilledWeeks: 0 },
  commercial: [
    { ref: "CA03", name: "Escalation", method: "%", include: "No", pct: "0", pcSum: "0" },
    { ref: "CA09", name: "Dewatering", method: "PC Sum", include: "No", pct: "0", pcSum: "0" },
    { ref: "CA17", name: "Overhead", method: "Markup %", include: "Yes", pct: "0.1", pcSum: "0" },
    { ref: "CA18", name: "Profit", method: "Margin %", include: "Yes", pct: "0.15", pcSum: "0" },
    { ref: "CA21", name: "GST", method: "%", include: "No", pct: "0.15", pcSum: "0" },
  ],
  overlays: [{ name: "Concrete sub", amount: "5000", kind: "QUOTED" }],
  overlap: "0",
  reference: null,
};
const server: ServerRecord[] = splitIntoPackages(inputs).flatMap((p, i) => Object.entries(p.records).map(([id, data]) => ({ id, packageId: `pkg-${i}-${p.key}`, data: JSON.parse(JSON.stringify(data)) })));
const pkgOf = (id: string) => server.find((r) => r.id === id)!.packageId;
const line = (ref: string) => server.find((r) => r.id === `ca:${ref}`)!.data.body as CaBody;
const ok = <T,>(r: { ok: boolean } & Record<string, any>): T => { if (!r.ok) throw new Error(r.error); return r.body as T; };

describe("commercial line edits", () => {
  it("reads percentages and sums as people type them", () => {
    expect(parsePercent("10")).toEqual({ ok: true, value: "0.1" });
    expect(parsePercent("7.5%")).toEqual({ ok: true, value: "0.075" });
    expect(parsePercent("ten")).toEqual({ ok: false });
    expect(parsePercent("-5")).toEqual({ ok: false });
    expect(parseSum("$3,000.50")).toEqual({ ok: true, value: "3000.5" });
    expect(parseSum("-500")).toEqual({ ok: false });
    expect(parseSum("-500", true)).toEqual({ ok: true, value: "-500" });
    expect(parseOverlap("TBC")).toMatchObject({ ok: false });
  });

  it("lets a person change only what each line actually uses", () => {
    expect(editableFields(line("CA03"), false)).toMatchObject({ include: true, method: true, pct: true, pcSum: false });
    expect(editableFields(line("CA09"), false)).toMatchObject({ method: true, pct: false, pcSum: true });
    expect(editableFields(line("CA21"), false)).toMatchObject({ method: false, pct: true });
    expect(editableFields({ ref: "CA10", name: "Weather", method: "Weather Engine", include: "Yes" }, false)).toMatchObject({ method: false, pct: false, pcSum: false });
    expect(editableFields({ ref: "CA16", name: "Reserve", method: "Fixed Amount", include: "Yes", pcSum: "100" }, true)).toMatchObject({ method: false, pcSum: false });
    expect(setCaField(line("CA03"), "pcSum", "100")).toMatchObject({ ok: false });
    expect(setCaField(line("CA09"), "method", "Margin %")).toMatchObject({ ok: false });
  });

  it("refuses a margin of 100% or more, which would stop the job calculating", () => {
    expect(setCaField(line("CA18"), "pct", "100")).toMatchObject({ ok: false, error: expect.stringContaining("below 100%") });
    expect(setCaField(line("CA18"), "pct", "99.9")).toMatchObject({ ok: true });
    expect(setCaField({ ...line("CA17"), ref: "CA18", method: "Markup %", pct: "1.5" }, "method", "Margin %")).toMatchObject({ ok: false });
  });

  it("moves the tender when a line is switched in and given a number", () => {
    const before = buildModel(effectiveRecords(server, {})).estimate.tender;
    let d: Drafts = {};
    const edit = (ref: string, field: string, v: unknown) => { d = editRecord(d, server, pkgOf(`ca:${ref}`), `ca:${ref}`, (b) => ok<CaBody>(setCaField(b, field, v))); };
    edit("CA09", "include", "Yes");
    edit("CA09", "pcSum", "3000");
    const after = buildModel(effectiveRecords(server, d)).estimate.tender;
    expect(after.subtotal.minus(before.subtotal).toString()).toBe("3000");
    // 3000 x 1.1 overhead, then true margin of 15%
    expect(Number(after.tenderExclGst) - Number(before.tenderExclGst)).toBeCloseTo((3000 * 1.1) / 0.85, 6);
    edit("CA18", "pct", "20");
    expect(Number(buildModel(effectiveRecords(server, d)).estimate.tender.profit)).toBeGreaterThan(Number(after.profit));
  });

  it("adds allowances CX01, CX02 and deletes only those", () => {
    const a = newAllowance("Crane standby", ["CA03", "CA17"], 30);
    expect(a).toMatchObject({ ok: true, recordId: "ca:CX01" });
    const b = newAllowance("Traffic management", ["CA03", "CX01"], 31);
    expect(b).toMatchObject({ ok: true, recordId: "ca:CX02" });
    expect(newAllowance("  ", [], 1)).toMatchObject({ ok: false });
    expect(canDeleteLine("CX01")).toBe(true);
    expect(canDeleteLine("CA09")).toBe(false);
    if (!a.ok) return;
    let d = addRecord({}, pkgOf("ca:CA03"), a.recordId, a.data);
    d = editRecord(d, server, pkgOf("ca:CA03"), "ca:CX01", (x) => ok<CaBody>(setCaField(x, "pcSum", "2500")));
    const t = buildModel(effectiveRecords(server, d)).estimate.tender;
    expect(t.additions.get("CX01")!.toString()).toBe("2500");
    expect(t.preMarginTotal.toString()).toBe("2500");
  });

  it("edits subcontract packages and the confirmed overlap", () => {
    const base = buildModel(effectiveRecords(server, {})).estimate.consolidated;
    let d: Drafts = {};
    const sub = pkgOf("overlay:Concrete sub");
    d = editRecord(d, server, sub, "overlay:Concrete sub", (b) => ok(setOverlayField(b, "amount", "$8,000")));
    const made = newOverlay("Drainage sub", ["Concrete sub"], 5);
    if (!made.ok) throw new Error(made.error);
    d = addRecord(d, sub, made.recordId, made.data);
    d = editRecord(d, server, sub, "overlay:Drainage sub", (b) => ok(setOverlayField(b, "amount", "1000")));
    d = editRecord(d, server, pkgOf("setting:overlap"), "setting:overlap", () => "500");
    const c = buildModel(effectiveRecords(server, d)).estimate.consolidated;
    expect(c.overlaysTotal.toString()).toBe("9000");
    expect(c.confirmedOverlap.toString()).toBe("500");
    expect(base.overlaysTotal.toString()).toBe("5000");
    expect(newOverlay("concrete SUB", ["Concrete sub"], 1)).toMatchObject({ ok: false, error: expect.stringContaining("already") });
    expect(setOverlayField({ name: "x", amount: "1" }, "amount", "lots")).toMatchObject({ ok: false });
  });
});
