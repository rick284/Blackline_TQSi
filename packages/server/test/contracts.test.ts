import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addPerson, jobWithEstimate, newCompany, testServer, type TestServer } from "./helpers.js";

let s: TestServer;
beforeAll(async () => { s = await testServer(); });
afterAll(async () => { await s.close(); });

/** A company with a job whose tender has been issued (an owner issues past the blockers: the estimate has no scope recorded). */
async function issued(name: string, revisions = 1) {
  const { owner } = await newCompany(s, name);
  const mgr = await addPerson(s, owner, "Maya", "manager");
  const est = await addPerson(s, owner, "Eli", "estimator");
  const { jobId } = await jobWithEstimate(s, owner);
  const revs: any[] = [];
  for (let i = 0; i < revisions; i++) revs.push((await owner.post(`/jobs/${jobId}/revisions`, { overrideReason: "Test" })).body);
  return { owner, mgr: mgr.client, est: est.client, jobId, revs };
}

describe("awarding a job", () => {
  it("is a manager's decision, and only for a job whose tender has been issued", async () => {
    const { owner } = await newCompany(s, "Stage Co");
    const mgr = await addPerson(s, owner, "Maya", "manager");
    const est = await addPerson(s, owner, "Eli", "estimator");
    const { jobId } = await jobWithEstimate(s, owner);
    const early = await mgr.client.post(`/jobs/${jobId}/award`, { revisionId: "00000000-0000-4000-8000-000000000000" });
    expect([early.status, early.body.error.code]).toEqual([409, "wrong_stage"]);
    const rev = (await owner.post(`/jobs/${jobId}/revisions`, { overrideReason: "Test" })).body;
    expect((await est.client.post(`/jobs/${jobId}/award`, { revisionId: rev.id })).status).toBe(403);
    expect((await mgr.client.get(`/jobs/${jobId}/contract`)).body).toEqual({ contract: null });
    expect((await mgr.client.post(`/jobs/${jobId}/award`, { revisionId: rev.id })).status).toBe(201);
  });

  it("copies the estimate's cost into the control budget, line by line, and records the contract sum and terms", async () => {
    const t = await issued("Budget Co");
    const r = await t.mgr.post(`/jobs/${t.jobId}/award`, { revisionId: t.revs[0].id, awardedOn: "2026-11-10", terms: { form: "NZS 3910:2023", payDays: "20", retentionPct: "5", startDate: "2026-12-01" } });
    expect(r.status).toBe(201);
    const c = r.body;
    expect(c.lines.map((l: any) => [l.code, l.kind, l.amount])).toEqual([["EW01", "qs", "10000.00"], ["PV01", "qs", "4000.00"], ["SUB-01", "subcontract", "5000.00"]]);
    expect(c.budget.cost).toBe("19000.00");
    expect(Number(c.tenderAllIn)).toBeCloseTo(Number(t.revs[0].totals.allIn), 2);
    expect(c.contractSum).toBe(c.tenderAllIn); // nothing else agreed
    expect(Number(c.budget.margin)).toBeCloseTo(Number(c.contractSum) - 19000, 2);
    expect([c.awardedOn, c.awardedBy, c.revision.label, c.revision.verified, c.revision.superseded]).toEqual(["2026-11-10", "Maya", "Rev A", true, false]);
    expect(c.terms).toMatchObject({ form: "NZS 3910:2023", payDays: "20", retentionPct: "5", startDate: "2026-12-01", claimDay: "" });
    expect((await t.owner.get(`/jobs/${t.jobId}`)).body.status).toBe("awarded");
    expect((await t.est.get(`/jobs/${t.jobId}/contract`)).body.contract.lines).toHaveLength(3); // anyone in the company can read it
  });

  it("takes the contract sum the client actually agreed, and shows the margin it leaves", async () => {
    const t = await issued("Sum Co");
    const c = (await t.mgr.post(`/jobs/${t.jobId}/award`, { revisionId: t.revs[0].id, contractSum: "$30,000" })).body;
    expect([c.contractSum, c.budget.margin, c.budget.marginPct]).toEqual(["30000.00", "11000.00", "36.67"]);
    const t2 = await issued("Bad Sum Co");
    expect((await t2.mgr.post(`/jobs/${t2.jobId}/award`, { revisionId: t2.revs[0].id, contractSum: "lots" })).status).toBe(400);
    expect((await t2.mgr.post(`/jobs/${t2.jobId}/award`, { revisionId: t2.revs[0].id, awardedOn: "2026-02-30" })).status).toBe(400);
    expect((await t2.mgr.post(`/jobs/${t2.jobId}/award`, { revisionId: t2.revs[0].id, terms: { form: "Handshake" } })).body.error.message).toContain("form must be one of");
  });

  it("can be made from an earlier revision the client accepted, and only once", async () => {
    const t = await issued("Two Revs Co", 2);
    const c = (await t.mgr.post(`/jobs/${t.jobId}/award`, { revisionId: t.revs[0].id })).body;
    expect([c.revision.label, c.revision.superseded]).toEqual(["Rev A", true]);
    const again = await t.mgr.post(`/jobs/${t.jobId}/award`, { revisionId: t.revs[1].id });
    expect([again.status, again.body.error.code]).toEqual([409, "already_awarded"]);
  });

  it("stops a tender being issued again once the job is awarded", async () => {
    const t = await issued("Frozen Co");
    await t.mgr.post(`/jobs/${t.jobId}/award`, { revisionId: t.revs[0].id });
    const r = await t.owner.post(`/jobs/${t.jobId}/revisions`, { overrideReason: "Test" });
    expect([r.status, r.body.error.code]).toEqual([409, "awarded"]);
  });

  it("keeps the budget as awarded: the database refuses any edit or delete of its lines", async () => {
    const t = await issued("Guard Co");
    await t.mgr.post(`/jobs/${t.jobId}/award`, { revisionId: t.revs[0].id });
    await expect(s.db.query("update contract_budget_lines set amount = '1.00' where code = 'EW01'")).rejects.toThrow(/cannot be edited or deleted/);
    await expect(s.db.query("delete from contract_budget_lines")).rejects.toThrow(/cannot be edited or deleted/);
  });

  it("won't award from a revision that no longer matches what was issued", async () => {
    const t = await issued("Tamper Co");
    await s.db.exec("alter table tender_revisions disable trigger tender_revisions_frozen");
    await s.db.query(`update tender_revisions set snapshot = jsonb_set(snapshot, '{0,data,kind}', '"tampered"') where id = $1`, [t.revs[0].id]);
    await s.db.exec("alter table tender_revisions enable trigger tender_revisions_frozen");
    const r = await t.mgr.post(`/jobs/${t.jobId}/award`, { revisionId: t.revs[0].id });
    expect([r.status, r.body.error.code]).toEqual([409, "revision_altered"]);
    expect((await t.owner.get(`/jobs/${t.jobId}`)).body.status).toBe("issued");
  });

  it("belongs to its company: another company can't read it, award it, or use its revisions", async () => {
    const a = await issued("Mine Co"), b = await newCompany(s, "Theirs Co");
    await a.mgr.post(`/jobs/${a.jobId}/award`, { revisionId: a.revs[0].id });
    expect((await b.owner.get(`/jobs/${a.jobId}/contract`)).status).toBe(404);
    expect((await b.owner.post(`/jobs/${a.jobId}/award`, { revisionId: a.revs[0].id })).status).toBe(404);
    expect((await b.owner.post(`/jobs/${a.jobId}/contract`, { notes: "x" })).status).toBe(404);
    const job = (await b.owner.post("/jobs", { name: "Their job" })).body;
    await s.db.query("update jobs set status = 'issued' where id = $1", [job.id]);
    expect((await b.owner.post(`/jobs/${job.id}/award`, { revisionId: a.revs[0].id })).status).toBe(404); // another job's revision
  });
});

describe("the contract terms", () => {
  it("are edited by a manager, checked, and recorded with what they were before", async () => {
    const t = await issued("Terms Co");
    await t.mgr.post(`/jobs/${t.jobId}/award`, { revisionId: t.revs[0].id, terms: { payDays: "20" } });
    expect((await t.est.post(`/jobs/${t.jobId}/contract`, { claimDay: "25th" })).status).toBe(403);
    const ok = await t.mgr.post(`/jobs/${t.jobId}/contract`, { claimDay: "25th", defectsMonths: "12", payDays: "30" });
    expect(ok.body.terms).toMatchObject({ claimDay: "25th", defectsMonths: "12", payDays: "30" });
    expect((await t.mgr.post(`/jobs/${t.jobId}/contract`, { retentionPct: "50" })).body.error.message).toContain("between 0 and 20");
    expect((await t.mgr.post(`/jobs/${t.jobId}/contract`, { completionDate: "2020-01-01", startDate: "2026-01-01" })).status).toBe(400);
    const audit = (await t.owner.get("/audit")).body as any[];
    expect(audit.find((a) => a.action === "contract.terms").detail).toMatchObject({ payDays: { from: "20", to: "30" }, claimDay: { from: "", to: "25th" } });
    expect(audit.some((a) => a.action === "contract.awarded")).toBe(true);
  });
});
