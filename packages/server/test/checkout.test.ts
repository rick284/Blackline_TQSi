import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addPerson, jobWithEstimate, newCompany, testServer, type TestServer } from "./helpers.js";

let s: TestServer;
beforeAll(async () => { s = await testServer(); });
afterAll(async () => { await s.close(); });

const ewEdit = (rate: string) => ({
  "row:EW01-001": {
    kind: "row", seq: 0,
    body: { qsCode: "EW01", mode: "Lump Sum / Quote", resourceType: "Subcontract", resourceCode: "SUB", manualQty: "1", jobRateOverride: rate, verified: "Yes", uid: "EW01-001" },
  },
});

async function setup(name: string) {
  const { owner } = await newCompany(s, name);
  const carlo = await addPerson(s, owner, "Carlo", "estimator");
  const rick = await addPerson(s, owner, "Rick", "estimator");
  const manager = await addPerson(s, owner, "Maya", "manager");
  const viewer = await addPerson(s, owner, "Vic", "viewer");
  const job = await jobWithEstimate(s, owner);
  return { owner, carlo, rick, manager, viewer, ...job, ew: job.byKey["qs:Earthworks"]! };
}

describe("checkout and check-in over the API", () => {
  it("locks a package to one person, and lists who holds it", async () => {
    const t = await setup("Lock Co");
    const out = await t.carlo.client.post(`/packages/${t.ew}/checkout`);
    expect(out.status).toBe(200);
    expect(out.body.version).toBe(1);
    expect(Object.keys(out.body.records)).toEqual(["qs:EW01", "row:EW01-001"]);

    const again = await t.rick.client.post(`/packages/${t.ew}/checkout`);
    expect([again.status, again.body.error.code]).toEqual([409, "already_checked_out"]);

    const list = (await t.rick.client.get(`/jobs/${t.jobId}/packages`)).body as any[];
    const ew = list.find((p) => p.key === "qs:Earthworks");
    expect(ew.lock).toMatchObject({ holder_name: "Carlo", base_version: 1 });
    expect(list.find((p) => p.key === "qs:Pavements").lock).toBeNull();
    // the same people can still work on a different package at the same time
    expect((await t.rick.client.post(`/packages/${t.byKey["qs:Pavements"]}/checkout`)).status).toBe(200);
  });

  it("applies a holder's check-in, raises the version and releases the lock", async () => {
    const t = await setup("Apply Co");
    await t.carlo.client.post(`/packages/${t.ew}/checkout`);
    const before = (await t.owner.get(`/jobs/${t.jobId}/estimate`)).body.estimate;
    expect(before.qs.totalDirect).toBe("14000");

    const ci = await t.carlo.client.post(`/packages/${t.ew}/checkin`, { baseVersion: 1, upserts: ewEdit("11000"), deletes: [] });
    expect([ci.status, ci.body.version]).toEqual([200, 2]);

    const after = (await t.owner.get(`/jobs/${t.jobId}/estimate`)).body;
    expect(after.estimate.qs.totalDirect).toBe("15000"); // the server recalculated from the stored records
    expect(after.checkedOut).toBe(0);
    expect(Number(after.estimate.consolidated.allInTender)).toBeGreaterThan(Number(before.consolidated.allInTender));
    expect((await t.rick.client.post(`/packages/${t.ew}/checkout`)).status).toBe(200); // free again, at version 2
  });

  it("deletes records named in the change set", async () => {
    const t = await setup("Delete Co");
    await t.carlo.client.post(`/packages/${t.ew}/checkout`);
    expect((await t.carlo.client.post(`/packages/${t.ew}/checkin`, { baseVersion: 1, upserts: {}, deletes: ["row:EW01-001"] })).status).toBe(200);
    const pkg = (await t.owner.get(`/packages/${t.ew}`)).body;
    expect(Object.keys(pkg.records)).toEqual(["qs:EW01"]);
    expect((await t.owner.get(`/jobs/${t.jobId}/estimate`)).body.estimate.qs.totalDirect).toBe("4000");
  });

  it("refuses a check-in from someone who does not hold the lock, applies nothing, and parks it", async () => {
    const t = await setup("Park Co");
    await t.carlo.client.post(`/packages/${t.ew}/checkout`);
    const r = await t.rick.client.post(`/packages/${t.ew}/checkin`, { baseVersion: 1, upserts: ewEdit("99999"), deletes: [] });
    expect([r.status, r.body.error.code]).toEqual([409, "not_holder"]);
    expect(r.body.parkedId).toBeTruthy();
    expect((await t.owner.get(`/jobs/${t.jobId}/estimate`)).body.estimate.qs.totalDirect).toBe("14000");
    const parked = (await t.manager.client.get(`/jobs/${t.jobId}/parked`)).body as any[];
    expect(parked).toHaveLength(1);
    expect(parked[0]).toMatchObject({ holder_name: "Rick", reason: "not-holder", package_name: "Earthworks" });
    expect(parked[0].changes.upserts["row:EW01-001"].body.jobRateOverride).toBe("99999");
  });

  it("a manager breaks a lost lock; the original holder's late check-in is parked, never applied", async () => {
    const t = await setup("Break Co");
    await t.carlo.client.post(`/packages/${t.ew}/checkout`); // Carlo flies out and loses signal
    expect((await t.rick.client.post(`/packages/${t.ew}/break-lock`)).status).toBe(403); // an estimator cannot break it
    const broke = await t.manager.client.post(`/packages/${t.ew}/break-lock`);
    expect(broke.status).toBe(200);
    expect(broke.body.brokenFrom).toBe(t.carlo.userId);

    // Rick takes the package and finishes his work: version 2
    await t.rick.client.post(`/packages/${t.ew}/checkout`);
    expect((await t.rick.client.post(`/packages/${t.ew}/checkin`, { baseVersion: 1, upserts: ewEdit("12000"), deletes: [] })).body.version).toBe(2);

    // Carlo lands and checks in the work he did on version 1
    const late = await t.carlo.client.post(`/packages/${t.ew}/checkin`, { baseVersion: 1, upserts: ewEdit("9000"), deletes: [] });
    expect(late.status).toBe(409);
    expect((await t.owner.get(`/jobs/${t.jobId}/estimate`)).body.estimate.qs.totalDirect).toBe("16000"); // Rick's 12,000 + 4,000, not Carlo's 9,000
    const parked = (await t.manager.client.get(`/jobs/${t.jobId}/parked`)).body as any[];
    expect(parked.map((p) => p.holder_name)).toEqual(["Carlo"]);

    // a manager marks it dealt with
    expect((await t.rick.client.post(`/parked/${parked[0].id}/resolve`)).status).toBe(403);
    expect((await t.manager.client.post(`/parked/${parked[0].id}/resolve`)).status).toBe(204);
    expect((await t.manager.client.get(`/jobs/${t.jobId}/parked`)).body).toHaveLength(0);
    expect((await t.manager.client.post(`/parked/${parked[0].id}/resolve`)).status).toBe(404);
  });

  it("parks a check-in made after a lock was broken even if nobody else edited", async () => {
    const t = await setup("Quiet Co");
    await t.carlo.client.post(`/packages/${t.ew}/checkout`);
    await t.manager.client.post(`/packages/${t.ew}/break-lock`);
    const late = await t.carlo.client.post(`/packages/${t.ew}/checkin`, { baseVersion: 1, upserts: ewEdit("9000"), deletes: [] });
    expect([late.status, late.body.error.code]).toEqual([409, "no_lock"]);
    expect((await t.owner.get(`/jobs/${t.jobId}/estimate`)).body.estimate.qs.totalDirect).toBe("14000");
  });

  it("refuses a check-in at the wrong base version", async () => {
    const t = await setup("Stale Co");
    await t.carlo.client.post(`/packages/${t.ew}/checkout`);
    const r = await t.carlo.client.post(`/packages/${t.ew}/checkin`, { baseVersion: 7, upserts: ewEdit("1"), deletes: [] });
    expect([r.status, r.body.error.code]).toEqual([409, "stale_base"]);
  });

  it("lets the holder release a lock; nobody else can", async () => {
    const t = await setup("Release Co");
    await t.carlo.client.post(`/packages/${t.ew}/checkout`);
    expect((await t.rick.client.post(`/packages/${t.ew}/release`)).status).toBe(403);
    expect((await t.carlo.client.post(`/packages/${t.ew}/release`)).status).toBe(204);
    expect((await t.carlo.client.post(`/packages/${t.ew}/release`)).body.error.code).toBe("not_locked");
    expect((await t.manager.client.post(`/packages/${t.ew}/break-lock`)).body.error.code).toBe("not_locked");
  });

  it("keeps a viewer out of checkout and check-in", async () => {
    const t = await setup("View Co");
    expect((await t.viewer.client.post(`/packages/${t.ew}/checkout`)).status).toBe(403);
    expect((await t.viewer.client.post(`/packages/${t.ew}/checkin`, { baseVersion: 1, upserts: {}, deletes: [] })).status).toBe(403);
    expect((await t.viewer.client.get(`/jobs/${t.jobId}/estimate`)).status).toBe(200);
  });

  it("validates a check-in body", async () => {
    const t = await setup("Valid Co");
    await t.carlo.client.post(`/packages/${t.ew}/checkout`);
    expect((await t.carlo.client.post(`/packages/${t.ew}/checkin`, { upserts: {} })).status).toBe(400); // no baseVersion
    expect((await t.carlo.client.post(`/packages/${t.ew}/checkin`, { baseVersion: 1, upserts: { x: { body: 1 } } })).status).toBe(400); // no kind
    expect((await t.carlo.client.post("/packages/not-a-uuid/checkout")).status).toBe(404);
  });

  it("takes add-only records without a lock; the first write wins and a replay is harmless", async () => {
    const t = await setup("Append Co");
    await t.carlo.client.post(`/packages/${t.ew}/checkout`); // a lock does not stop add-only records
    const a = await t.rick.client.post(`/jobs/${t.jobId}/append`, { recordId: "quote-1", data: { amount: "100" } });
    const b = await t.rick.client.post(`/jobs/${t.jobId}/append`, { recordId: "quote-1", data: { amount: "999" } });
    expect([a.status, a.body.created, b.status, b.body.created]).toEqual([201, true, 200, false]);
    const row = (await s.db.query<{ data: any }>("select data from append_records where record_id = 'quote-1' and job_id = $1", [t.jobId])).rows[0]!;
    expect(row.data.amount).toBe("100");
  });

  it("writes an audit trail of what happened and who did it", async () => {
    const t = await setup("Audit Co");
    await t.carlo.client.post(`/packages/${t.ew}/checkout`);
    await t.carlo.client.post(`/packages/${t.ew}/checkin`, { baseVersion: 1, upserts: ewEdit("11000"), deletes: [] });
    await t.rick.client.post(`/packages/${t.ew}/checkin`, { baseVersion: 2, upserts: {}, deletes: [] });
    const actions = ((await t.manager.client.get("/audit")).body as any[]).map((a) => a.action);
    for (const a of ["org.created", "job.created", "job.seeded", "package.checked_out", "package.checked_in", "package.checkin_refused", "member.added"]) expect(actions).toContain(a);
  });
  it("hands a client every checked-in record with its package, so it can recalculate on its own machine", async () => {
    const t = await setup("Records Co");
    const r = await t.viewer.client.get(`/jobs/${t.jobId}/records`);
    expect(r.status).toBe(200);
    expect(r.body.packages.length).toBe(Object.keys(t.byKey).length);
    const ids = r.body.records.map((x: any) => x.id);
    expect(ids).toContain("row:EW01-001");
    expect(r.body.records.find((x: any) => x.id === "row:EW01-001").packageId).toBe(t.ew);
  });  it("says what a parked change was based on, so only what they changed can be compared", async () => {
    const t = await setup("Base Co");
    await t.carlo.client.post(`/packages/${t.ew}/checkout`);                                  // Carlo takes version 1 ...
    await t.manager.client.post(`/packages/${t.ew}/break-lock`);                              // ... his lock is broken ...
    await t.rick.client.post(`/packages/${t.ew}/checkout`);
    await t.rick.client.post(`/packages/${t.ew}/checkin`, { baseVersion: 1, upserts: ewEdit("12000"), deletes: [] }); // ... and Rick changes the rate (version 2)
    const late = await t.carlo.client.post(`/packages/${t.ew}/checkin`, { baseVersion: 1, upserts: ewEdit("9000"), deletes: ["qs:EW01"] });
    expect(late.status).toBe(409);
    const parked = (await t.manager.client.get(`/jobs/${t.jobId}/parked`)).body as any[];
    expect(parked[0].base["row:EW01-001"].body.jobRateOverride).toBe("10000"); // what it was at version 1, not Rick's 12,000
    expect(parked[0].base["qs:EW01"].body.code).toBe("EW01");                  // a record they deleted is described too
    expect(parked[0].base_version).toBe(1);
  });

  it("keeps each record's value at each version", async () => {
    const t = await setup("History Co");
    await t.carlo.client.post(`/packages/${t.ew}/checkout`);
    await t.carlo.client.post(`/packages/${t.ew}/checkin`, { baseVersion: 1, upserts: ewEdit("11000"), deletes: ["qs:EW01"] });
    const v = (await s.db.query<{ version: number; data: any }>("select version, data from record_versions where package_id = $1 and record_id = $2 order by version", [t.ew, "row:EW01-001"])).rows;
    expect(v.map((x) => [x.version, x.data.body.jobRateOverride])).toEqual([[1, "10000"], [2, "11000"]]);
    const gone = (await s.db.query<{ version: number; data: any }>("select version, data from record_versions where package_id = $1 and record_id = 'qs:EW01' order by version", [t.ew])).rows;
    expect(gone.map((x) => [x.version, x.data === null])).toEqual([[1, false], [2, true]]);
  });

  it("refuses a check-in that both changes and deletes the same record", async () => {
    const t = await setup("Overlap Co");
    await t.carlo.client.post(`/packages/${t.ew}/checkout`);
    const r = await t.carlo.client.post(`/packages/${t.ew}/checkin`, { baseVersion: 1, upserts: ewEdit("1"), deletes: ["row:EW01-001"] });
    expect(r.status).toBe(400);
  });});
