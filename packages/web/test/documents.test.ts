import { describe, expect, it } from "vitest";
import { documents as DOC, splitIntoPackages, type TenderInputs } from "@blackline/tender/core";
import { addRecord, effectiveRecords, type ServerRecord } from "../src/lib/draft.js";
import { clearFlags, groupFlags, newDocument, newRevision } from "../src/lib/documents.js";
import { buildModel } from "../src/lib/model.js";

describe("adding documents and revisions", () => {
  const docs: DOC.TenderDoc[] = [{ id: "D1", ref: "DOC-01", title: "Civil drawings", category: "drawing", note: "" }];
  const revs: DOC.DocRevision[] = [{ id: "D1-1", docId: "D1", rev: "Rev A", date: "", addendum: "", note: "" }];
  it("a new document comes with its first revision, numbered and in order", () => {
    const r = newDocument({ title: "Geotech report", category: "report", rev: "Rev 0" }, docs, revs, { doc: 5000, rev: 6000 });
    if (!r.ok) throw new Error(r.error);
    expect(r.items.map((i) => i.recordId)).toEqual(["doc:D2", "docrev:D2-1"]);
    expect(r.items[0]!.data.body).toMatchObject({ ref: "DOC-02", category: "report" });
    expect(r.items[1]!.data.body).toMatchObject({ rev: "Rev 0", docId: "D2" });
    expect(newDocument({ title: "x", category: "report", rev: "" }, docs, revs, { doc: 1, rev: 1 })).toMatchObject({ ok: true });
    expect(newDocument({ title: " ", category: "report", rev: "" }, docs, revs, { doc: 1, rev: 1 })).toMatchObject({ ok: false });
  });
  it("a new revision gets the next free id and is refused for a repeated label or a false date", () => {
    const r = newRevision("D1", { rev: "Rev B", date: "2026-11-02", addendum: "Addendum 1", note: "Pipe size" }, revs, 7000);
    expect(r).toMatchObject({ ok: true, items: [{ recordId: "docrev:D1-2" }] });
    expect(newRevision("D1", { rev: "Rev A" }, revs, 1)).toMatchObject({ ok: false });
    expect(newRevision("D1", { rev: "Rev C", date: "tomorrow" }, revs, 1)).toMatchObject({ ok: false });
  });
  it("clearing a flag needs a note, and writes one record per flag", () => {
    const f = [{ key: "D1-2|scope:SC-001", revId: "D1-2", target: "scope:SC-001" }, { key: "D1-2|cost:EW01", revId: "D1-2", target: "cost:EW01" }];
    expect(clearFlags(f, "  ", "Eli", new Date())).toMatchObject({ ok: false });
    const r = clearFlags(f, "Checked: no change", "Eli", new Date("2026-11-03T00:00:00Z"));
    expect(r).toMatchObject({ ok: true, items: [{ recordId: "docclear:D1-2|scope:SC-001" }, { recordId: "docclear:D1-2|cost:EW01" }] });
  });
});

describe("Tender Documents in the job model", () => {
  const inputs: TenderInputs = {
    library: [{ code: "SUB", description: "Subcontract", unit: "ea", baseRate: "1" }],
    qs: [{ code: "EW01", section: "Earthworks", description: "Strip", unit: "m2", quantity: "100" }],
    rows: [{ qsCode: "EW01", mode: "Lump Sum / Quote", resourceType: "Subcontract", resourceCode: "SUB", manualQty: "1", jobRateOverride: "1000", verified: "Yes", uid: "EW01-001" }],
    weatherLinks: { dailyUid: "", hoursPerDay: 8, weeklyUids: [] }, tool: { exposedPool: 0, rainWetGroundCost: 0, criticalPathDelayWd: 0, additionalBilledWeeks: 0 },
    commercial: [{ ref: "CA17", name: "Overhead", method: "Markup %", include: "Yes", pct: "0.1", pcSum: "0" }], overlays: [], overlap: "0", reference: null,
    scope: [{ id: "SC-001", ref: "SC-001", group: "Permanent works", title: "Earthworks", detail: "", source: "", owner: "OWN WORKS", treatment: "PRICED", cost_refs: "EW01", register_refs: "DOC-01", quote_refs: "", basis: "", action: "" }],
  };
  const server: ServerRecord[] = [
    ...splitIntoPackages(inputs).flatMap((p, i) => Object.entries(p.records).map(([id, data]) => ({ id, packageId: `pkg-${i}`, data: JSON.parse(JSON.stringify(data)) }))),
    ...Object.entries(DOC.documentsPackage([{ id: "R1", kind: "document", ref: "DOC-01", title: "Civil drawings", detail: "Rev A", action: "", status: "", rag: "", owner: "", likelihood: "", impact: "", rating: "" }]).records)
      .map(([id, data]) => ({ id, packageId: "pkg-docs", data: JSON.parse(JSON.stringify(data)) })),
  ];

  it("is empty until started, and then shows the documents with nothing to check", () => {
    const none = buildModel(server.filter((r) => r.packageId !== "pkg-docs"));
    expect([none.documentsPackageId, none.estimate.documents.documents.length]).toEqual(["", 0]);
    const m = buildModel(server);
    expect([m.documentsPackageId, m.estimate.documents.documents.map((d) => d.ref), m.estimate.documents.open]).toEqual(["pkg-docs", ["DOC-01"], 0]);
  });

  it("a revision added in a draft raises flags at once, clearing them in the draft lifts the block", () => {
    const rev = newRevision("D1", { rev: "Rev B", addendum: "Addendum 1", note: "Pipe size" }, [{ id: "D1-1", docId: "D1", rev: "Rev A", date: "", addendum: "", note: "" }], 9000);
    if (!rev.ok) throw new Error(rev.error);
    let d = addRecord({}, "pkg-docs", rev.items[0]!.recordId, rev.items[0]!.data);
    const m = buildModel(effectiveRecords(server, d));
    expect(m.estimate.documents.open).toBe(2); // the scope item and its estimate line
    expect(m.gates.blockers.some((g) => g.id === "documents")).toBe(true);
    const cleared = clearFlags(groupFlags(m.estimate.documents.flags)[0]!.flags, "Checked, no effect", "Eli", new Date());
    if (!cleared.ok) throw new Error(cleared.error);
    for (const i of cleared.items) d = addRecord(d, "pkg-docs", i.recordId, i.data);
    const after = buildModel(effectiveRecords(server, d));
    expect([after.estimate.documents.open, after.gates.blockers.some((g) => g.id === "documents")]).toEqual([0, false]);
  });
});
