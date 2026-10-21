import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addPerson, jobWithEstimate, newCompany, testServer, type TestServer } from "./helpers.js";

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

  it("is refused by the database itself if anyone tries to edit, delete or re-supersede it", async () => {
    const t = await ready("Guarded Co");
    const a = (await t.mgr.post(`/jobs/${t.jobId}/revisions`, {})).body;
    const b = (await t.mgr.post(`/jobs/${t.jobId}/revisions`, {})).body;
    await expect(s.db.query("update tender_revisions set snapshot = '[]'::jsonb where id = $1", [a.id])).rejects.toThrow(/cannot be edited/);
    await expect(s.db.query("update tender_revisions set label = 'Rev Z' where id = $1", [a.id])).rejects.toThrow(/cannot be edited/);
    await expect(s.db.query("update tender_revisions set totals = '{}'::jsonb where id = $1", [b.id])).rejects.toThrow(/cannot be edited/);
    await expect(s.db.query("delete from tender_revisions where id = $1", [a.id])).rejects.toThrow(/cannot be deleted/);
    await expect(s.db.query("update tender_revisions set superseded_by = $1 where id = $2", [a.id, a.id])).rejects.toThrow(/already been superseded/);
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
