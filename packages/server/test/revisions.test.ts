import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addPerson, jobWithEstimate, newCompany, testServer, refuses, pgStandIn, type TestServer } from "./helpers.js";

let s: TestServer;
beforeAll(async () => { s = await testServer(); });
afterAll(async () => { await s.close(); });

const scopeRecord = { kind: "scope", seq: 1000, body: { id: "S1", ref: "SC-001", group: "Permanent works", title: "All the work", detail: "", source: "", owner: "OWN WORKS", treatment: "PRICED", cost_refs: "EW01, PV01", register_refs: "", quote_refs: "", basis: "", action: "" } };

/** A company with a job, an estimator and a manager, and the scope recorded so the tender has no blockers. */
async function ready(name: string, withScope = true) {
  const { owner } = await newCompany(s, name);
  const mgr = await addPerson(s, owner, "Maya", "manager");
  const est = await addPerson(s, owner, "Eli", "estimator");
  const { jobId, byKey } = await jobWithEstimate(s, owner);
  if (withScope) {
    const out = await est.client.post(`/packages/${byKey.narrative}/checkout`);
    expect(out.status).toBe(200);
    expect((await est.client.post(`/packages/${byKey.narrative}/checkin`, { baseVersion: 1, upserts: { "scope:S1": scopeRecord }, deletes: [] })).status).toBe(200);
  }
  return { owner, mgr: mgr.client, est: est.client, jobId, byKey };
}

describe("issuing a tender", () => {
  it("is for managers; blockers stop it, and only an owner can issue past them with a reason that stays on the revision", async () => {
    const t = await ready("Blocked Co", false);
    expect((await t.est.post(`/jobs/${t.jobId}/revisions`, {})).status).toBe(403);
    const blocked = await t.mgr.post(`/jobs/${t.jobId}/revisions`, {});
    expect([blocked.status, blocked.body.error.code]).toEqual([409, "blocked"]);
    expect(blocked.body.error.message).toContain("No scope has been recorded");
    // a manager can't override, even with a reason
    expect((await t.mgr.post(`/jobs/${t.jobId}/revisions`, { overrideReason: "Client wants it today" })).status).toBe(403);
    const issued = await t.owner.post(`/jobs/${t.jobId}/revisions`, { note: "Early price", overrideReason: "Client wants a budget price today" });
    expect(issued.status).toBe(201);
    expect(issued.body).toMatchObject({ label: "Rev A", seq: 1, note: "Early price", verified: true, supersededBy: null });
    expect(issued.body.overrides[0]).toMatchObject({ reason: "Client wants a budget price today" });
    expect(issued.body.overrides[0].text).toContain("No scope");
    expect(Number(issued.body.totals.allIn)).toBeGreaterThan(0);
    expect((await t.owner.get(`/jobs/${t.jobId}`)).body.status).toBe("issued");
  });

  it("issues cleanly once the scope is backed up, supersedes the one before, and says who and when", async () => {
    const t = await ready("Clean Co");
    const a = await t.mgr.post(`/jobs/${t.jobId}/revisions`, { note: "First issue" });
    expect([a.status, a.body.label, a.body.overrides]).toEqual([201, "Rev A", []]);
    const b = await t.mgr.post(`/jobs/${t.jobId}/revisions`, { note: "After addendum 1" });
    expect([b.body.label, b.body.seq]).toEqual(["Rev B", 2]);
    const list = (await t.owner.get(`/jobs/${t.jobId}/revisions`)).body as any[];
    expect(list.map((r) => [r.label, r.supersededByLabel])).toEqual([["Rev B", null], ["Rev A", "Rev B"]]);
    expect(list[0].issuedBy).toBe("Maya");
    expect(list.every((r) => r.verified)).toBe(true);
  });

  it("won't issue while anything is checked out, and says who has it", async () => {
    const t = await ready("Locked Co");
    expect((await t.est.post(`/packages/${t.byKey.library}/checkout`)).status).toBe(200);
    const r = await t.mgr.post(`/jobs/${t.jobId}/revisions`, {});
    expect([r.status, r.body.error.code]).toEqual([409, "packages_checked_out"]);
    expect(r.body.error.message).toContain("Rate Library (Eli)");
  });
});

describe("a revision is frozen", () => {
  it("keeps what was sent when the live job moves on, and says it is unchanged", async () => {
    const t = await ready("Frozen Co");
    const a = (await t.mgr.post(`/jobs/${t.jobId}/revisions`, {})).body;
    // change the live job: a different price on an earthworks row
    expect((await t.est.post(`/packages/${t.byKey["qs:Earthworks"]}/checkout`)).status).toBe(200);
    const live = (await t.est.get(`/jobs/${t.jobId}/records`)).body.records.find((r: any) => r.id === "row:EW01-001");
    const changed = { ...live.data, body: { ...live.data.body, jobRateOverride: "99999" } };
    expect((await t.est.post(`/packages/${t.byKey["qs:Earthworks"]}/checkin`, { baseVersion: 1, upserts: { "row:EW01-001": changed }, deletes: [] })).status).toBe(200);
    const was = (await t.owner.get(`/revisions/${a.id}/records`)).body;
    expect(was.revision.verified).toBe(true);
    expect(was.records.find((r: any) => r.id === "row:EW01-001").data.body.jobRateOverride).toBe("10000");
    expect(was.records.some((r: any) => r.id === "scope:S1")).toBe(true); // the scope and everything else came with it
    const now = (await t.owner.get(`/jobs/${t.jobId}/records`)).body.records.find((r: any) => r.id === "row:EW01-001");
    expect(now.data.body.jobRateOverride).toBe("99999");
  });

  it.skipIf(pgStandIn)("is refused by the database itself if anyone tries to edit, delete or re-supersede it", async () => {
    const t = await ready("Guarded Co");
    const a = (await t.mgr.post(`/jobs/${t.jobId}/revisions`, {})).body;
    const b = (await t.mgr.post(`/jobs/${t.jobId}/revisions`, {})).body;
    await refuses(s.db.query("update tender_revisions set snapshot = '[]'::jsonb where id = $1", [a.id]), /cannot be edited/);
    await refuses(s.db.query("update tender_revisions set label = 'Rev Z' where id = $1", [a.id]), /cannot be edited/);
    await refuses(s.db.query("update tender_revisions set totals = '{}'::jsonb where id = $1", [b.id]), /cannot be edited/);
    await refuses(s.db.query("delete from tender_revisions where id = $1", [a.id]), /cannot be deleted/);
    await refuses(s.db.query("update tender_revisions set superseded_by = $1 where id = $2", [a.id, a.id]), /already been superseded/);
    // the only change a row ever takes is being superseded: B can be, once
    const c = (await t.mgr.post(`/jobs/${t.jobId}/revisions`, {})).body;
    expect(c.label).toBe("Rev C");
    expect(((await t.owner.get(`/jobs/${t.jobId}/revisions`)).body as any[]).find((r) => r.label === "Rev B").supersededByLabel).toBe("Rev C");
  });

  it("shows a revision that has been tampered with underneath the application as not verified", async () => {
    const t = await ready("Tamper Co");
    const a = (await t.mgr.post(`/jobs/${t.jobId}/revisions`, {})).body;
    await s.db.exec("alter table tender_revisions disable trigger tender_revisions_frozen");
    await s.db.query(`update tender_revisions set snapshot = jsonb_set(snapshot, '{0,data,kind}', '"tampered"') where id = $1`, [a.id]);
    await s.db.exec("alter table tender_revisions enable trigger tender_revisions_frozen");
    expect(((await t.owner.get(`/jobs/${t.jobId}/revisions`)).body as any[])[0].verified).toBe(false);
    expect((await t.owner.get(`/revisions/${a.id}/records`)).body.revision.verified).toBe(false);
  });

  it("belongs to its company: nobody else can list or read it", async () => {
    const t = await ready("Mine Co");
    const a = (await t.mgr.post(`/jobs/${t.jobId}/revisions`, {})).body;
    const other = await newCompany(s, "Other Co");
    expect((await other.owner.get(`/jobs/${t.jobId}/revisions`)).status).toBe(404);
    expect((await other.owner.get(`/revisions/${a.id}/records`)).status).toBe(404);
    expect((await other.owner.post(`/jobs/${t.jobId}/revisions`, {})).status).toBe(404);
  });
});

describe("a changed document holds the tender", () => {
  const docRev = (id: string, docId: string, rev: string, seq: number) => ({ kind: "tenderDocRev", seq, body: { id, docId, rev, date: "", addendum: "Addendum 1", note: "Pipe size" } });

  it("starts from the register's documents, blocks issuing while a revision is unchecked, and issues once it is cleared", async () => {
    const t = await ready("Docs Co");
    // the register holds a document the scope item cites
    const reg = { kind: "register", seq: 1, body: { id: "R-DOC-01", kind: "document", ref: "DOC-01", title: "Civil drawings", detail: "Rev A", action: "", status: "", rag: "", owner: "", likelihood: "", impact: "", rating: "" } };
    expect((await t.est.post(`/packages/${t.byKey.narrative}/checkout`)).status).toBe(200);
    const cite = { ...scopeRecord, body: { ...scopeRecord.body, register_refs: "DOC-01" } };
    expect((await t.est.post(`/packages/${t.byKey.narrative}/checkin`, { baseVersion: 2, upserts: { "register:R-DOC-01": reg, "scope:S1": cite }, deletes: [] })).status).toBe(200);

    expect((await t.est.post(`/jobs/${t.jobId}/documents`, {})).body.created).toBe(true);
    expect((await t.est.post(`/jobs/${t.jobId}/documents`, {})).body.created).toBe(false);
    const all = (await t.owner.get(`/jobs/${t.jobId}/records`)).body as { packages: { id: string; key: string }[]; records: { id: string }[] };
    expect(all.records.filter((r) => r.id.startsWith("doc")).map((r) => r.id)).toEqual(["doc:D1", "docrev:D1-1"]);

    // a new revision arrives: the scope item and its estimate lines are flagged
    const pkg = all.packages.find((p) => p.key === "documents")!.id;
    expect((await t.est.post(`/packages/${pkg}/checkout`)).status).toBe(200);
    expect((await t.est.post(`/packages/${pkg}/checkin`, { baseVersion: 1, upserts: { "docrev:D1-2": docRev("D1-2", "D1", "Rev B", 2000) }, deletes: [] })).status).toBe(200);
    const blocked = await t.mgr.post(`/jobs/${t.jobId}/revisions`, {});
    expect([blocked.status, blocked.body.error.code]).toEqual([409, "blocked"]);
    expect(blocked.body.error.message).toContain("document change");

    // someone checks each flag and says so
    const flags = ["scope:SC-001", "cost:EW01", "cost:PV01"].map((target) => [`docclear:D1-2|${target}`, { kind: "tenderDocClear", body: { revId: "D1-2", target, note: "Checked, no effect", by: "Eli", at: "2026-11-03T00:00:00Z" } }]);
    expect((await t.est.post(`/packages/${pkg}/checkout`)).status).toBe(200);
    expect((await t.est.post(`/packages/${pkg}/checkin`, { baseVersion: 2, upserts: Object.fromEntries(flags), deletes: [] })).status).toBe(200);
    const issued = await t.mgr.post(`/jobs/${t.jobId}/revisions`, { note: "After addendum 1" });
    expect([issued.status, issued.body.label]).toEqual([201, "Rev A"]);
  });
});

describe("procurement holds the tender", () => {
  it("starts from the quote register, and a selected quote with an exclusion nobody dealt with blocks issuing until it is", async () => {
    const t = await ready("Procure Co");
    const quote = { kind: "quote", seq: 1, body: { id: "Q-01", ref: "Q-01", package: "Concrete sub", supplier: "Coast Concrete", estimate_ref: "", qty: "", unit: "", amount: "5000", scope: "", documents: "", status: "", action: "", notes: "", treatment: "", verification: "", source: "", quote_date: "", valid_until: "" } };
    expect((await t.est.post(`/packages/${t.byKey.narrative}/checkout`)).status).toBe(200);
    expect((await t.est.post(`/packages/${t.byKey.narrative}/checkin`, { baseVersion: 2, upserts: { "quote:Q-01": quote }, deletes: [] })).status).toBe(200);

    expect((await t.est.post(`/jobs/${t.jobId}/procurement`, {})).body.created).toBe(true);
    expect((await t.est.post(`/jobs/${t.jobId}/procurement`, {})).body.created).toBe(false);
    const all = (await t.owner.get(`/jobs/${t.jobId}/records`)).body as { packages: { id: string; key: string }[]; records: { id: string; data: any }[] };
    expect(all.records.find((r) => r.id === "pp:P1")!.data.body).toMatchObject({ name: "Concrete sub", overlay: "Concrete sub" });

    const pkg = all.packages.find((p) => p.key === "procurement")!.id;
    const selected = { kind: "procPackage", seq: 1000, body: { id: "P1", name: "Concrete sub", overlay: "Concrete sub", scope: "", selected: "Q-01", reason: "Only quote", by: "Eli", at: "2026-11-01T00:00:00Z" } };
    const level = (treatment: string) => ({ kind: "procLevel", body: { quoteRef: "Q-01", adjustments: [], exclusions: [{ text: "Rock excavation", treatment, note: "" }], note: "" } });
    expect((await t.est.post(`/packages/${pkg}/checkout`)).status).toBe(200);
    expect((await t.est.post(`/packages/${pkg}/checkin`, { baseVersion: 1, upserts: { "pp:P1": selected, "pl:Q-01": level("") }, deletes: [] })).status).toBe(200);
    const blocked = await t.mgr.post(`/jobs/${t.jobId}/revisions`, {});
    expect([blocked.status, blocked.body.error.code]).toEqual([409, "blocked"]);
    expect(blocked.body.error.message).toContain("selected quotes");

    expect((await t.est.post(`/packages/${pkg}/checkout`)).status).toBe(200);
    expect((await t.est.post(`/packages/${pkg}/checkin`, { baseVersion: 2, upserts: { "pl:Q-01": level("by others") }, deletes: [] })).status).toBe(200);
    expect((await t.mgr.post(`/jobs/${t.jobId}/revisions`, {})).status).toBe(201);
  });
});

describe("the Submission package", () => {
  it("starts with the letter and qualifications drafted from the register, once, for an estimator", async () => {
    const { owner } = await newCompany(s, "Letter Co");
    const est = await addPerson(s, owner, "Eli", "estimator");
    const vic = await addPerson(s, owner, "Vic", "viewer");
    const { jobId } = await jobWithEstimate(s, owner, "Hobsonville");
    expect((await vic.client.post(`/jobs/${jobId}/submission`, {})).status).toBe(403);
    const a = await est.client.post(`/jobs/${jobId}/submission`, {});
    expect([a.status, a.body.created]).toEqual([201, true]);
    expect((await est.client.post(`/jobs/${jobId}/submission`, {})).body.created).toBe(false);
    const all = (await owner.get(`/jobs/${jobId}/records`)).body as { records: { id: string; data: any }[] };
    const letter = all.records.find((r) => r.id === "sub:letter")!.data.body;
    expect([letter.addressee, letter.subject, letter.validityDays]).toEqual(["Client", "Tender for Hobsonville", "30"]);
  });
});
