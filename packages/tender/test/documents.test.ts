import { describe, expect, it } from "vitest";
import { assembleInputs, computeTenderEstimate, splitIntoPackages, type TenderInputs } from "../src/index.js";
import * as DOC from "../src/documents.js";
import { gates } from "../src/submission.js";
import type { RegisterItem } from "../src/register.js";
import type { ScopeItem } from "../src/scope.js";
import type { Quote } from "../src/quotes.js";

const scopeItem = (ref: string, o: Partial<ScopeItem> = {}): ScopeItem => ({
  id: ref, ref, group: "Permanent works", title: `Item ${ref}`, detail: "", source: "", owner: "OWN WORKS", treatment: "PRICED", cost_refs: "", register_refs: "", quote_refs: "", basis: "", action: "", ...o,
});
const quote = (ref: string, o: Partial<Quote> = {}): Quote => ({
  id: ref, ref, package: "Civil", supplier: "Allied", estimate_ref: "", qty: "", unit: "", amount: "100", scope: "", documents: "", status: "", action: "", notes: "", treatment: "", verification: "", source: "", quote_date: "", valid_until: "", ...o,
});
const doc = (id: string, ref: string, seq: number): DOC.TenderDoc & { seq: number } => ({ id, ref, title: `Doc ${ref}`, category: "drawing", note: "", seq });
const rev = (id: string, docId: string, r: string, seq: number, o: Partial<DOC.DocRevision> = {}): DOC.DocRevision & { seq: number } => ({ id, docId, rev: r, date: "", addendum: "", note: "", seq, ...o });

describe("building documents and revisions", () => {
  it("numbers a new document and refuses a repeated reference", () => {
    expect(DOC.buildDocument("D3", { title: "Civil drawings" }, [{ ref: "DOC-01" }, { ref: "DOC-02" }])).toMatchObject({ ref: "DOC-03", category: "drawing" });
    expect(() => DOC.buildDocument("D3", { title: "X", ref: "doc-01" }, [{ ref: "DOC-01" }])).toThrow("already used");
    expect(() => DOC.buildDocument("D3", { title: " " }, [])).toThrow("Name the document");
    expect(() => DOC.buildDocument("D3", { title: "X", category: "photo" }, [])).toThrow("Category must be");
  });
  it("checks a revision: a label, no repeat, a real date", () => {
    const have = [{ docId: "D1", rev: "Rev A" }];
    expect(DOC.buildRevision("r2", "D1", { rev: "Rev B", date: "2026-11-02", addendum: "Addendum 1", note: "Pipe size" }, have)).toMatchObject({ rev: "Rev B", date: "2026-11-02" });
    expect(() => DOC.buildRevision("r2", "D1", { rev: "rev a" }, have)).toThrow("already been recorded");
    expect(() => DOC.buildRevision("r2", "D1", { rev: "" }, have)).toThrow("Say which revision");
    expect(() => DOC.buildRevision("r2", "D1", { rev: "Rev B", date: "2026-02-30" }, have)).toThrow("real date");
    expect(DOC.buildRevision("r2", "D2", { rev: "Rev A" }, have).rev).toBe("Rev A"); // another document may reuse the label
  });
  it("edits fields within limits", () => {
    const d = doc("D1", "DOC-01", 1);
    expect(DOC.setDocField(d, "category", "Specification")).toMatchObject({ category: "specification" });
    expect(() => DOC.setDocField(d, "title", "")).toThrow();
    expect(() => DOC.setDocField(d, "colour", "red")).toThrow("can't be edited");
  });
});

describe("a new revision flags what depends on the document", () => {
  const scope = [scopeItem("SC-001", { register_refs: "DOC-01", cost_refs: "EW01, PV01", quote_refs: "Q-01" }), scopeItem("SC-002", { register_refs: "DOC-02", cost_refs: "KB01" })];
  const quotes = [quote("Q-01"), quote("Q-02", { documents: "Priced from DOC-01 Rev A drawings" }), quote("Q-03", { documents: "DOC-010 only" })];
  const input: DOC.DocumentsInput = {
    docs: [doc("D1", "DOC-01", 1), doc("D2", "DOC-02", 2), doc("D3", "DOC-03", 3)],
    revisions: [rev("D1-1", "D1", "Rev A", 1), rev("D2-1", "D2", "Rev A", 2), rev("D3-1", "D3", "Rev A", 3), rev("D1-2", "D1", "Rev B", 4, { addendum: "Addendum 1", date: "2026-11-02", note: "Pipe size 300 to 375" })],
    clears: [],
  };

  it("raises nothing for a document as first received", () => {
    const r = DOC.computeDocuments({ ...input, revisions: input.revisions.slice(0, 3) }, scope, quotes);
    expect([r.open, r.flags.length]).toEqual([0, 0]);
    expect(r.gate).toMatch(/^PASS/);
  });

  it("flags the scope items, estimate lines and quotes that cite the changed document", () => {
    const r = DOC.computeDocuments(input, scope, quotes, { EW01: "Bulk earthworks" });
    expect(r.flags.map((f) => f.target)).toEqual(["scope:SC-001", "cost:EW01", "cost:PV01", "quote:Q-01", "quote:Q-02"]);
    expect(r.flags.find((f) => f.target === "cost:EW01")!.label).toBe("Estimate line EW01: Bulk earthworks");
    expect(r.flags.every((f) => f.open && f.rev === "Rev B" && f.addendum === "Addendum 1")).toBe(true); // Q-03 cites DOC-010, not DOC-01
    expect(r.open).toBe(5);
    expect(r.documents[0]).toMatchObject({ openFlags: 5, current: { rev: "Rev B" } });
    expect(r.gate).toMatch(/^HOLD - 5 document changes/);
  });

  it("says so when nothing cites the changed document, because then nobody knows what it touches", () => {
    const r = DOC.computeDocuments({ ...input, revisions: [...input.revisions, rev("D3-2", "D3", "Rev B", 5)] }, scope, quotes);
    const f = r.flags.filter((x) => x.docRef === "DOC-03");
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ kind: "unlinked", target: "unlinked:DOC-03" });
  });

  it("holds each flag open until it is cleared with a note, and keeps who cleared it", () => {
    const clears: DOC.FlagClear[] = [{ revId: "D1-2", target: "scope:SC-001", note: "Checked: no change to the item", by: "Eli", at: "2026-11-03T01:00:00Z" }, { revId: "gone", target: "scope:SC-001", note: "x", by: "x", at: "" }];
    const r = DOC.computeDocuments({ ...input, clears }, scope, quotes);
    expect(r.open).toBe(4);
    expect(r.flags[0]).toMatchObject({ open: false, clear: { by: "Eli" } });
    const all = DOC.computeDocuments({ ...input, clears: r.flags.map((f) => ({ revId: f.revId, target: f.target, note: "ok", by: "Eli", at: "" })) }, scope, quotes);
    expect([all.open, all.gate.slice(0, 4)]).toEqual([0, "PASS"]);
  });

  it("a later revision raises its own flags even when the earlier one was cleared", () => {
    const cleared = DOC.computeDocuments(input, scope, quotes).flags.map((f) => ({ revId: f.revId, target: f.target, note: "ok", by: "Eli", at: "" }));
    const r = DOC.computeDocuments({ ...input, revisions: [...input.revisions, rev("D1-3", "D1", "Rev C", 6)], clears: cleared }, scope, quotes);
    expect(r.open).toBe(5);
    expect(new Set(r.flags.filter((f) => f.open).map((f) => f.rev))).toEqual(new Set(["Rev C"]));
  });

  it("lists the addenda with what each changed", () => {
    const r = DOC.computeDocuments({ ...input, revisions: [...input.revisions, rev("D2-2", "D2", "Rev B", 5, { addendum: "Addendum 1", date: "2026-11-05" })] }, scope, quotes);
    expect(r.addenda).toEqual([{ name: "Addendum 1", date: "2026-11-05", items: [{ docRef: "DOC-01", rev: "Rev B" }, { docRef: "DOC-02", rev: "Rev B" }] }]);
  });
});

describe("a started document register in the estimate", () => {
  const register: RegisterItem[] = [
    { id: "R-DOC-01", kind: "document", ref: "DOC-01", title: "Civil plans / drawings", detail: "Rev C 12-Aug\n\nEstimate use: quantities", action: "", status: "", rag: "", owner: "", likelihood: "", impact: "", rating: "" },
    { id: "R-DOC-02", kind: "document", ref: "DOC-02", title: "Geotechnical report (GIR)", detail: "", action: "", status: "", rag: "", owner: "", likelihood: "", impact: "", rating: "" },
    { id: "R-EX-01", kind: "exclusion", ref: "EX-01", title: "Foundations", detail: "", action: "", status: "", rag: "", owner: "", likelihood: "", impact: "", rating: "" },
  ];
  it("starts from the register's documents, with nothing flagged", () => {
    const p = DOC.documentsPackage(register);
    expect([p.key, p.kind, Object.keys(p.records)]).toEqual(["documents", "documents", ["doc:D1", "doc:D2", "docrev:D1-1", "docrev:D2-1"]]);
    expect(p.records["doc:D1"]!.body).toMatchObject({ ref: "DOC-01", category: "drawing" });
    expect(p.records["doc:D2"]!.body).toMatchObject({ category: "report" });
    const kinds = DOC.documentsPackage(["Specifications", "Geotechnical / ground information", "Client BOQ", "Email clarification 3", "Site photos"].map((title, i) => ({ ...register[0]!, id: `x${i}`, ref: `DOC-${i}`, title }))).records;
    expect(Object.values(kinds).filter((r) => r.kind === "tenderDoc").map((r) => (r.body as DOC.TenderDoc).category)).toEqual(["specification", "report", "boq", "correspondence", "other"]);
    expect(p.records["docrev:D1-1"]!.body).toMatchObject({ rev: "Rev C 12-Aug" });
    expect(p.records["docrev:D2-1"]!.body).toMatchObject({ rev: "As received" });
  });

  const base: TenderInputs = {
    library: [{ code: "SUB", description: "Subcontract", unit: "ea", baseRate: "1" }],
    qs: [{ code: "EW01", section: "Earthworks", description: "Strip", unit: "m2", quantity: "100" }],
    rows: [{ qsCode: "EW01", mode: "Lump Sum / Quote", resourceType: "Subcontract", resourceCode: "SUB", manualQty: "1", jobRateOverride: "1000", verified: "Yes", uid: "EW01-001" }],
    weatherLinks: { dailyUid: "", hoursPerDay: 8, weeklyUids: [] }, tool: { exposedPool: 0, rainWetGroundCost: 0, criticalPathDelayWd: 0, additionalBilledWeeks: 0 },
    commercial: [{ ref: "CA17", name: "Overhead", method: "Markup %", include: "Yes", pct: "0.1", pcSum: "0" }], overlays: [], overlap: "0", reference: null,
    scope: [scopeItem("SC-001", { register_refs: "DOC-01", cost_refs: "EW01" })],
  };
  const withDocs = (revisions: ReturnType<typeof rev>[], clears: DOC.FlagClear[] = []): TenderInputs => ({
    ...base, documents: { docs: [doc("D1", "DOC-01", 1)], revisions: [rev("D1-1", "D1", "Rev A", 1), ...revisions], clears },
  });

  it("blocks issuing while a change is unchecked, and lets it through once cleared", () => {
    const open = computeTenderEstimate(withDocs([rev("D1-2", "D1", "Rev B", 2)]));
    expect(open.documents.open).toBe(2);
    expect(gates(open).blockers.find((g) => g.id === "documents")).toMatchObject({ where: "documents", count: 2 });
    const clears = open.documents.flags.map((f) => ({ revId: f.revId, target: f.target, note: "ok", by: "Eli", at: "" }));
    expect(gates(computeTenderEstimate(withDocs([rev("D1-2", "D1", "Rev B", 2)], clears))).blockers.some((g) => g.id === "documents")).toBe(false);
  });

  it("is stored as its own package and rebuilt exactly, and a job without one is unaffected", () => {
    const inputs = withDocs([rev("D1-2", "D1", "Rev B", 2)], [{ revId: "D1-2", target: "scope:SC-001", note: "ok", by: "Eli", at: "x" }]);
    const parts = splitIntoPackages(inputs);
    expect(parts.some((p) => p.key === "documents")).toBe(false); // started separately, like the Gantt and the Submission
    const records = [...parts.flatMap((p) => Object.entries(p.records)), ...Object.entries(DOC.documentsPackage(register).records)].map(([id, data]) => ({ id, data }));
    expect(assembleInputs(records).documents!.docs.map((d) => d.ref)).toEqual(["DOC-01", "DOC-02"]);
    expect(computeTenderEstimate(base).documents).toMatchObject({ open: 0, flags: [] });
    expect(gates(computeTenderEstimate(base)).blockers.some((g) => g.id === "documents")).toBe(false);
  });
});
