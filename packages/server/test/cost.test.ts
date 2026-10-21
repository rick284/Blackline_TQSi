import { costControl as K } from "@blackline/tender";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ledgerOf, costData } from "../src/repo/cost.js";
import { ctxOf, addPerson, jobWithEstimate, newCompany, testServer, refuses, type TestServer } from "./helpers.js";

let s: TestServer;
beforeAll(async () => { s = await testServer(); });
afterAll(async () => { await s.close(); });

/** An awarded job: EW01 10,000, PV01 4,000 and SUB-01 5,000 in the control budget, 5% retention in the terms. */
async function awarded(name: string) {
  const { owner } = await newCompany(s, name);
  const mgr = await addPerson(s, owner, "Maya", "manager");
  const est = await addPerson(s, owner, "Eli", "estimator");
  const vic = await addPerson(s, owner, "Vic", "viewer");
  const { jobId } = await jobWithEstimate(s, owner);
  const rev = (await owner.post(`/jobs/${jobId}/revisions`, { overrideReason: "Test" })).body;
  expect((await mgr.client.post(`/jobs/${jobId}/award`, { revisionId: rev.id, terms: { retentionPct: "5" } })).status).toBe(201);
  const summary = async (o: K.CostOptions = {}) => { const d = await costData(s.db, await ctxOf(owner), jobId); return K.costControl(ledgerOf(d), o); };
  return { owner, mgr: mgr.client, est: est.client, vic: vic.client, jobId, summary };
}
const day = "2026-11-10";

describe("cost control starts at award", () => {
  it("is not there for a job that has not been awarded, for anyone", async () => {
    const { owner } = await newCompany(s, "Early Co");
    const { jobId } = await jobWithEstimate(s, owner);
    for (const r of [await owner.get(`/jobs/${jobId}/cost`), await owner.post(`/jobs/${jobId}/cost/commitments`, { code: "EW01", supplier: "A", amount: "1", date: day })]) {
      expect([r.status, r.body.error.code]).toEqual([409, "not_awarded"]);
    }
  });
});

describe("commitments and actual costs", () => {
  it("are booked by an estimator to a line in the budget, and the order's invoices reduce what is still committed", async () => {
    const t = await awarded("Ledger Co");
    expect((await t.vic.post(`/jobs/${t.jobId}/cost/commitments`, { code: "SUB-01", supplier: "Allied", amount: "5000", date: day })).status).toBe(403);
    expect((await t.est.post(`/jobs/${t.jobId}/cost/commitments`, { code: "ZZ99", supplier: "Allied", amount: "5000", date: day })).body.error.message).toContain("isn't a line in the control budget");
    const po = (await t.est.post(`/jobs/${t.jobId}/cost/commitments`, { code: "SUB-01", supplier: "Allied", ref: "PO-1", amount: "$5,000", date: day })).body;
    expect((await t.est.post(`/jobs/${t.jobId}/cost/actuals`, { code: "SUB-01", kind: "invoice", supplier: "Allied", ref: "INV-77", amount: "2000", date: day, commitmentId: po.id })).status).toBe(201);
    await t.est.post(`/jobs/${t.jobId}/cost/actuals`, { code: "EW01", kind: "labour", supplier: "Crew", amount: "750.50", hours: "12", date: day });
    const r = await t.summary();
    expect(r.lines.map((l) => [l.code, l.actual.toString(), l.committed.toString(), l.forecastFinal.toString()])).toEqual([["EW01", "750.5", "0", "10000"], ["PV01", "0", "0", "4000"], ["SUB-01", "2000", "3000", "5000"]]);
    expect(r.project.actualLabourHours.toString()).toBe("12");
    const cost = (await t.vic.get(`/jobs/${t.jobId}/cost`)).body; // anyone in the company can look
    expect([cost.commitments.length, cost.actuals.length, cost.contract.budget.cost]).toEqual([1, 2, "19000.00"]);
  });

  it("refuse a bad order link, a bad amount and a made-up kind", async () => {
    const t = await awarded("Checks Co");
    const b = (extra: object) => t.est.post(`/jobs/${t.jobId}/cost/actuals`, { code: "EW01", kind: "invoice", amount: "100", date: day, ...extra });
    expect((await b({ commitmentId: "00000000-0000-4000-8000-000000000000" })).body.error.message).toContain("isn't one of this job's commitments");
    expect((await b({ amount: "a lot" })).status).toBe(400);
    expect((await b({ amount: "0" })).status).toBe(400);
    expect((await b({ kind: "gift" })).status).toBe(400);
    expect((await b({ date: "2026-02-30" })).status).toBe(400);
    expect((await b({ amount: "-100" })).status).toBe(201); // a credit note
  });

  it("are never edited or deleted: a manager voids them with a reason, and a voided one counts for nothing", async () => {
    const t = await awarded("Void Co");
    const a = (await t.est.post(`/jobs/${t.jobId}/cost/actuals`, { code: "EW01", kind: "invoice", amount: "900", date: day })).body;
    expect((await t.est.post(`/jobs/${t.jobId}/cost/actuals/${a.id}/void`, { reason: "Wrong job" })).status).toBe(403);
    expect((await t.mgr.post(`/jobs/${t.jobId}/cost/actuals/${a.id}/void`, { reason: "x" })).status).toBe(400);
    expect((await t.mgr.post(`/jobs/${t.jobId}/cost/actuals/${a.id}/void`, { reason: "Booked to the wrong job" })).status).toBe(204);
    expect((await t.mgr.post(`/jobs/${t.jobId}/cost/actuals/${a.id}/void`, { reason: "Again" })).body.error.code).toBe("already_voided");
    expect((await t.summary()).project.actualCostToDate.toString()).toBe("0");
    const kept = (await t.owner.get(`/jobs/${t.jobId}/cost`)).body.actuals[0];
    expect([kept.voided, kept.voidReason]).toEqual([true, "Booked to the wrong job"]);
    await refuses(s.db.query("update cost_actuals set amount = '1.00' where id = $1", [a.id]), /voided entry cannot be changed|cannot be edited/);
    await refuses(s.db.query("delete from cost_actuals where id = $1", [a.id]), /cannot be deleted/);
    const b = (await t.est.post(`/jobs/${t.jobId}/cost/actuals`, { code: "EW01", kind: "invoice", amount: "500", date: day })).body;
    await refuses(s.db.query("update cost_actuals set amount = '1.00' where id = $1", [b.id]), /cannot be edited/);
  });
});

describe("variations", () => {
  it("are proposed by an estimator, can be reworded while pending, and move the budget and contract sum only when a manager approves", async () => {
    const t = await awarded("Var Co");
    const v = (await t.est.post(`/jobs/${t.jobId}/cost/variations`, { title: "Extra kerb", sell: "3000", lines: [{ code: "PV01", amount: "1500" }, { code: "VAR-01", description: "Kerb", amount: "600" }] })).body;
    expect(v.ref).toBe("V01");
    expect((await t.est.post(`/jobs/${t.jobId}/cost/actuals`, { code: "VAR-01", kind: "invoice", amount: "100", date: day })).status).toBe(400); // not a line until approved
    expect((await t.est.post(`/jobs/${t.jobId}/cost/variations/${v.id}`, { title: "Extra kerb and channel", sell: "3200", lines: [{ code: "PV01", amount: "1500" }, { code: "VAR-01", description: "Kerb", amount: "600" }] })).status).toBe(204);
    expect((await t.est.post(`/jobs/${t.jobId}/cost/variations/${v.id}/decision`, { decision: "approved" })).status).toBe(403);
    expect((await t.mgr.post(`/jobs/${t.jobId}/cost/variations/${v.id}/decision`, { decision: "rejected" })).status).toBe(400);
    let r = await t.summary();
    expect([r.project.currentContractValue.toString() === r.project.originalContractValue.toString(), r.pending.sell.toString(), r.pending.cost.toString()]).toEqual([true, "3200", "2100"]);
    expect((await t.mgr.post(`/jobs/${t.jobId}/cost/variations/${v.id}/decision`, { decision: "approved", note: "Client email 2 Nov" })).status).toBe(204);
    r = await t.summary();
    expect(r.project.revisedBudget.toString()).toBe("21100");
    expect(Number(r.project.currentContractValue.toString()) - Number(r.project.originalContractValue.toString())).toBe(3200);
    expect(r.lines.map((l) => l.code)).toEqual(["EW01", "PV01", "SUB-01", "VAR-01"]);
    expect((await t.est.post(`/jobs/${t.jobId}/cost/actuals`, { code: "VAR-01", kind: "invoice", amount: "100", date: day })).status).toBe(201); // now it is
    expect((await t.est.post(`/jobs/${t.jobId}/cost/variations/${v.id}`, { title: "Changed again", sell: "1", lines: [] })).body.error.code).toBe("variation_decided");
    expect((await t.mgr.post(`/jobs/${t.jobId}/cost/variations/${v.id}/decision`, { decision: "rejected", note: "changed my mind" })).body.error.code).toBe("variation_decided");
    await refuses(s.db.query("update cost_variations set sell = '1.00' where id = $1", [v.id]), /decided variation cannot be changed/);
  });

  it("keeps when it was sent, when the client should reply by and whether work has started at risk, and warns when the reply is late", async () => {
    const t = await awarded("Dates Co");
    const bad = await t.est.post(`/jobs/${t.jobId}/cost/variations`, { title: "x", sell: "100", submittedOn: "2026-11-06", responseDue: "2026-11-01" });
    expect([bad.status, bad.body.error.message]).toEqual([400, "The client's reply can't be due before the variation was sent."]);
    expect((await t.est.post(`/jobs/${t.jobId}/cost/variations`, { title: "x", sell: "100", submittedOn: "2026-02-30" })).status).toBe(400);
    const v = (await t.est.post(`/jobs/${t.jobId}/cost/variations`, { title: "Extra kerb", sell: "3000", submittedOn: "2026-10-30", responseDue: "2026-11-06" })).body;
    const read = async () => (await t.owner.get(`/jobs/${t.jobId}/cost`)).body.variations[0];
    expect(await read()).toMatchObject({ submittedOn: "2026-10-30", responseDue: "2026-11-06", atRisk: false });
    const late = await t.summary({ today: "2026-11-10" });
    expect(late.warnings.map((w) => [w.severity, w.title])).toEqual([["Medium", "V01: Response overdue"]]);
    expect((await t.summary({ today: "2026-11-05" })).warnings).toEqual([]);
    expect((await t.est.post(`/jobs/${t.jobId}/cost/variations/${v.id}`, { title: "Extra kerb", sell: "3000", submittedOn: "2026-10-30", responseDue: "2026-11-06", atRisk: true })).status).toBe(204);
    expect(await read()).toMatchObject({ atRisk: true });
    expect((await t.summary({ today: "2026-11-05" })).warnings.map((w) => w.warning_type)).toEqual(["Work Proceeding At Risk"]);
    // once approved there is nothing left to chase
    await t.mgr.post(`/jobs/${t.jobId}/cost/variations/${v.id}/decision`, { decision: "approved" });
    expect((await t.summary({ today: "2026-11-10" })).warnings).toEqual([]);
  });

  it("warns that a claim is overdue once the contract's payment days have passed since it went in", async () => {
    const t = await awarded("Overdue Co");
    expect((await t.mgr.post(`/jobs/${t.jobId}/contract`, { payDays: "10" })).status).toBe(200);
    const c = (await t.mgr.post(`/jobs/${t.jobId}/cost/claims`, { periodEnd: "2026-10-31", valueEx: "8000" })).body;
    await t.mgr.post(`/jobs/${t.jobId}/cost/claims/${c.id}`, { status: "submitted", on: "2026-10-26" });
    const r = await t.summary({ today: "2026-11-10" });
    expect(r.warnings.map((w) => [w.severity, w.title, w.description])).toEqual([["Critical", "Claim 1: Payment overdue", "Payment was due 2026-11-09."]]);
    expect((await t.summary({ today: "2026-11-09" })).warnings).toEqual([]);
  });

  it("a rejected one is kept, with the reason, and changes nothing", async () => {
    const t = await awarded("Reject Co");
    const v = (await t.est.post(`/jobs/${t.jobId}/cost/variations`, { title: "Too dear", sell: "9000", lines: [{ code: "EW01", amount: "4000" }] })).body;
    expect((await t.mgr.post(`/jobs/${t.jobId}/cost/variations/${v.id}/decision`, { decision: "rejected", note: "Client declined the price" })).status).toBe(204);
    const r = await t.summary();
    expect([r.project.revisedBudget.toString(), r.pending.count]).toEqual(["19000", 0]);
    expect((await t.owner.get(`/jobs/${t.jobId}/cost`)).body.variations[0]).toMatchObject({ status: "rejected", decisionNote: "Client declined the price" });
    const dup = await t.est.post(`/jobs/${t.jobId}/cost/variations`, { ref: "V01", title: "Same number", sell: "1" });
    expect([dup.status, dup.body.error.code]).toEqual([409, "variation_exists"]);
  });
});

describe("forecasts", () => {
  it("move the forecast, the latest one wins, a blank clears it, and the earlier ones are kept", async () => {
    const t = await awarded("Forecast Co");
    const set = (etc: string) => t.est.post(`/jobs/${t.jobId}/cost/forecast`, { code: "EW01", etc, note: "Site visit" });
    expect((await t.vic.post(`/jobs/${t.jobId}/cost/forecast`, { code: "EW01", etc: "1" })).status).toBe(403);
    await set("12000"); await set("13000");
    let r = await t.summary();
    expect([r.lines[0]!.forecastFinal.toString(), r.lines[0]!.status, r.lines[0]!.etcManual]).toEqual(["13000", "Over Budget", true]);
    expect(r.project.marginDrift.lt(0)).toBe(true);
    await set("");
    r = await t.summary();
    expect([r.lines[0]!.forecastFinal.toString(), r.lines[0]!.etcManual]).toEqual(["10000", false]);
    expect(Number((await s.db.query("select count(*)::int as n from cost_forecasts where job_id = $1", [t.jobId])).rows[0]!.n)).toBe(3);
    await refuses(s.db.query("update cost_forecasts set etc = '1.00' where job_id = $1", [t.jobId]), /kept as entered/);
  });
});

describe("payment claims and retention", () => {
  it("are made by a manager at the retention in the contract terms, and move from draft to submitted to paid", async () => {
    const t = await awarded("Claims Co");
    expect((await t.est.post(`/jobs/${t.jobId}/cost/claims`, { periodEnd: "2026-11-30", valueEx: "8000" })).status).toBe(403);
    const c1 = (await t.mgr.post(`/jobs/${t.jobId}/cost/claims`, { periodEnd: "2026-11-30", valueEx: "8000" })).body;
    expect(c1.seq).toBe(1);
    expect((await t.mgr.post(`/jobs/${t.jobId}/cost/claims/${c1.id}`, { status: "submitted" })).body.error.message).toContain("date submitted");
    expect((await t.mgr.post(`/jobs/${t.jobId}/cost/claims/${c1.id}`, { status: "submitted", on: "2026-12-01" })).status).toBe(204);
    let r = await t.summary();
    expect([r.claims[0]!.retention.toString(), r.claims[0]!.netInc.toString(), r.claimed.value.toString(), r.claimed.outstanding.toString()]).toEqual(["400", "8740", "8000", "8740"]);
    expect((await t.mgr.post(`/jobs/${t.jobId}/cost/claims/${c1.id}`, { status: "paid", on: "2026-12-20", paidAmount: "8740" })).status).toBe(204);
    expect((await t.mgr.post(`/jobs/${t.jobId}/cost/claims/${c1.id}`, { status: "submitted", on: "2026-12-21" })).body.error.code).toBe("wrong_stage");
    r = await t.summary();
    expect([r.claimed.paid.toString(), r.claimed.outstanding.toString()]).toEqual(["8740", "0"]);
    const c2 = (await t.mgr.post(`/jobs/${t.jobId}/cost/claims`, { periodEnd: "2026-12-31", valueEx: "3000" })).body;
    expect(c2.seq).toBe(2);
    expect((await t.mgr.post(`/jobs/${t.jobId}/cost/claims/${c2.id}/void`, { reason: "Entered twice" })).status).toBe(204);
    expect((await t.summary()).claims.map((c) => c.seq)).toEqual([1]);
  });
});

describe("cost control belongs to its company", () => {
  it("another company gets 404 for everything, and the audit trail records who did what", async () => {
    const a = await awarded("Mine Co"), b = await newCompany(s, "Theirs Co");
    const act = (await a.est.post(`/jobs/${a.jobId}/cost/actuals`, { code: "EW01", kind: "invoice", amount: "10", date: day })).body;
    for (const [m, url] of [["GET", `/jobs/${a.jobId}/cost`], ["POST", `/jobs/${a.jobId}/cost/commitments`], ["POST", `/jobs/${a.jobId}/cost/actuals/${act.id}/void`], ["POST", `/jobs/${a.jobId}/cost/claims`]] as const) {
      expect([url, (await b.owner.call(m, url, { reason: "xxx" })).status]).toEqual([url, 404]);
    }
    const audit = (await a.owner.get("/audit")).body as any[];
    expect(audit.find((x) => x.action === "cost.actual").detail).toMatchObject({ code: "EW01", amount: "10.00" });
  });
});
