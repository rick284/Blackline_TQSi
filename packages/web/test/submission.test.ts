import { describe, expect, it } from "vitest";
import { splitIntoPackages, submission, type TenderInputs } from "@blackline/tender/core";
import { addRecord, editRecord, effectiveRecords, type ServerRecord } from "../src/lib/draft.js";
import { buildModel } from "../src/lib/model.js";
import { newAlternative, newQualification, setAltField, setLetterField, setQualField } from "../src/lib/submission.js";

describe("the tender letter", () => {
  const l = submission.defaultLetter({ name: "329 Hobsonville Road", client: "TPW" });
  it("starts from the job, and takes edits within limits", () => {
    expect([l.addressee, l.subject, l.validityDays]).toEqual(["TPW", "Tender for 329 Hobsonville Road", "30"]);
    expect(setLetterField(l, "attention", " Dave Stewart ")).toMatchObject({ ok: true, body: { attention: "Dave Stewart" } });
    expect(setLetterField(l, "validityDays", "45")).toMatchObject({ ok: true, body: { validityDays: "45" } });
    expect(setLetterField(l, "validityDays", "a month")).toMatchObject({ ok: false });
    expect(setLetterField(l, "subject", "x".repeat(301))).toMatchObject({ ok: false });
    expect(setLetterField(l, "colour", "red")).toMatchObject({ ok: false });
    expect(l.attention).toBe("");
  });
});

describe("qualifications and alternatives", () => {
  const q: submission.Qualification = { id: "Q1", kind: "exclusion", ref: "EX-01", text: "Foundations by others", include: true };
  it("edits a qualification, switches it off, and won't empty it", () => {
    expect(setQualField(q, "text", " Slab and foundations by others ")).toMatchObject({ ok: true, body: { text: "Slab and foundations by others" } });
    expect(setQualField(q, "include", false)).toMatchObject({ ok: true, body: { include: false } });
    expect(setQualField(q, "text", "  ")).toMatchObject({ ok: false });
    expect(setQualField(q, "kind", "rfi")).toMatchObject({ ok: false });
  });
  it("adds your own, in order, with the next free id", () => {
    const made = newQualification("Prices exclude GST", ["Q1", "Q3"], 5000);
    expect(made).toMatchObject({ ok: true, recordId: "sub:q:Q2" });
    expect(made.ok && made.data.body).toMatchObject({ kind: "custom", include: true });
    expect(newQualification(" ", [], 1)).toMatchObject({ ok: false });
  });
  it("alternatives: a title, a description and an amount that may be a saving", () => {
    const a = (newAlternative("Concrete paths instead of AP40", [], 1) as any).data.body as submission.Alternative;
    expect(a).toMatchObject({ id: "A1", amount: "", include: true });
    expect(setAltField(a, "amount", "$12,500.50")).toMatchObject({ ok: true, body: { amount: "12500.5" } });
    expect(setAltField(a, "amount", "-3000")).toMatchObject({ ok: true, body: { amount: "-3000" } });
    expect(setAltField(a, "amount", "TBC")).toMatchObject({ ok: false });
    expect(setAltField(a, "title", "")).toMatchObject({ ok: false });
    expect(newAlternative("", [], 1)).toMatchObject({ ok: false });
  });
});

describe("the Submission package in the job model", () => {
  const inputs: TenderInputs = {
    library: [{ code: "SUB", description: "Subcontract", unit: "ea", baseRate: "1" }],
    qs: [{ code: "EW01", section: "Earthworks", description: "Strip", unit: "m2", quantity: "100" }],
    rows: [{ qsCode: "EW01", mode: "Lump Sum / Quote", resourceType: "Subcontract", resourceCode: "SUB", manualQty: "1", jobRateOverride: "1000", verified: "Yes", uid: "EW01-001" }],
    weatherLinks: { dailyUid: "", hoursPerDay: 8, weeklyUids: [] },
    tool: { exposedPool: 0, rainWetGroundCost: 0, criticalPathDelayWd: 0, additionalBilledWeeks: 0 },
    commercial: [{ ref: "CA17", name: "Overhead", method: "Markup %", include: "Yes", pct: "0.1", pcSum: "0" }], overlays: [], overlap: "0", reference: null,
  };
  const server: ServerRecord[] = splitIntoPackages(inputs).flatMap((p, i) => Object.entries(p.records).map(([id, data]) => ({ id, packageId: `pkg-${i}-${p.key}`, data: JSON.parse(JSON.stringify(data)) })));

  it("has nothing until it is started, and says what blocks the tender", () => {
    const m = buildModel(server);
    expect(m.submission).toEqual({ packageId: "", letter: null, qualifications: [], alternatives: [] });
    expect(m.gates.blockers.map((g) => g.id)).toContain("scope-none");
  });
  it("shows the letter and the lists once there, in order, and updates as they are edited", () => {
    const seed = submission.submissionSeed({ name: "Roads", client: "Council" }, [{ id: "R-EX-01", kind: "exclusion", ref: "EX-01", title: "Rock", detail: "", action: "", status: "", rag: "", owner: "", likelihood: "", impact: "", rating: "" }]);
    const all = [...server, ...Object.entries(seed.records).map(([id, data]) => ({ id, packageId: "pkg-sub", data }))];
    const m = buildModel(all);
    expect([m.submission.packageId, m.submission.letter!.addressee, m.submission.qualifications.map((q) => q.ref)]).toEqual(["pkg-sub", "Council", ["EX-01"]]);
    const more = newQualification("Prices exclude GST", m.submission.qualifications.map((q) => q.id), 9000);
    if (!more.ok) throw new Error(more.error);
    let d = addRecord({}, "pkg-sub", more.recordId, more.data);
    d = editRecord(d, all, "pkg-sub", "sub:letter", (b) => ({ ...b, attention: "Sam" }));
    const m2 = buildModel(effectiveRecords(all, d));
    expect(m2.submission.qualifications.map((q) => q.text)).toEqual(["Rock", "Prices exclude GST"]);
    expect(m2.submission.letter!.attention).toBe("Sam");
  });
});
