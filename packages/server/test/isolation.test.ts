/**
 * Company separation. A person in one company must not be able to see, change, lock or even detect another company's data, whatever
 * ids they supply. Every answer about another company's data is the same 404 as for data that does not exist.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { splitIntoPackages } from "@blackline/tender";
import * as jobs from "../src/repo/jobs.js";
import { Client, ctxOf, jobWithEstimate, newCompany, testServer, tiny, type TestServer } from "./helpers.js";

let s: TestServer;
beforeAll(async () => { s = await testServer(); });
afterAll(async () => { await s.close(); });

let n = 0;
async function twoCompanies() {
  n++;
  const a = await newCompany(s, `Alpha Civil ${n}`);
  const b = await newCompany(s, `Bravo Builders ${n}`);
  const job = await jobWithEstimate(s, a.owner, "Alpha secret job");
  await a.owner.post(`/jobs/${job.jobId}/append`, { recordId: "r1", data: { x: 1 } });
  return { a, b, ...job };
}

describe("company isolation", () => {
  it("lists only a company's own jobs", async () => {
    const { b } = await twoCompanies();
    expect((await b.owner.get("/jobs")).body).toEqual([]);
    await b.owner.post("/jobs", { name: "Bravo job" });
    expect(((await b.owner.get("/jobs")).body as any[]).map((j) => j.name)).toEqual(["Bravo job"]);
  });

  it("answers 404 for every read of another company's job", async () => {
    const { b, jobId } = await twoCompanies();
    for (const url of [`/jobs/${jobId}`, `/jobs/${jobId}/packages`, `/jobs/${jobId}/estimate`, `/jobs/${jobId}/parked`, `/jobs/${jobId}/records`]) {
      const r = await b.owner.get(url);
      expect([url, r.status, r.body.error.code]).toEqual([url, 404, "not_found"]);
    }
  });

  it("gives another company's job the same answer as a job that does not exist", async () => {
    const { b, jobId } = await twoCompanies();
    const real = await b.owner.get(`/jobs/${jobId}`);
    const fake = await b.owner.get("/jobs/00000000-0000-4000-8000-000000000000");
    expect(real.status).toBe(fake.status);
    expect(real.body).toEqual(fake.body);
  });

  it("will not let another company's owner lock, edit, break or read a package", async () => {
    const { b, byKey } = await twoCompanies();
    const pkg = byKey["qs:Earthworks"]!;
    for (const [method, url, body] of [
      ["GET", `/packages/${pkg}`], ["POST", `/packages/${pkg}/checkout`], ["POST", `/packages/${pkg}/release`], ["POST", `/packages/${pkg}/break-lock`],
      ["POST", `/packages/${pkg}/checkin`, { baseVersion: 1, upserts: { "row:EW01-001": { kind: "row", body: {} } }, deletes: [] }],
    ] as const) {
      const r = await b.owner.call(method, url, body ?? {});
      expect([method, url, r.status]).toEqual([method, url, 404]);
    }
  });

  it("will not let another company add records to, import into, or resolve parked changes of another company's job", async () => {
    const { a, b, jobId, byKey } = await twoCompanies();
    expect((await b.owner.post(`/jobs/${jobId}/append`, { recordId: "evil", data: {} })).status).toBe(404);
    expect((await b.owner.call("POST", `/jobs/${jobId}/import-workbook`, undefined, { raw: Buffer.from("x") })).status).toBe(404); // the job check comes before the file is read
    await expect(jobs.seedPackages(s.db, await ctxOf(b.owner), jobId, splitIntoPackages(tiny))).rejects.toMatchObject({ status: 404 }); // and the repository refuses on its own
    // Alpha's estimator parks a change; Bravo cannot resolve it
    const pkg = byKey["qs:Earthworks"]!;
    const ctx = await ctxOf(a.owner);
    await a.owner.post(`/packages/${pkg}/checkout`);
    const refused = await a.owner.post(`/packages/${pkg}/checkin`, { baseVersion: 9, upserts: {}, deletes: [] });
    expect(refused.status).toBe(409);
    expect((await b.owner.post(`/parked/${refused.body.parkedId}/resolve`)).status).toBe(404);
    expect(ctx.orgId).toBe(a.orgId);
  });

  it("keeps the audit trail to a company's own events", async () => {
    const { a, b } = await twoCompanies();
    const bAudit = (await b.owner.get("/audit")).body as any[];
    expect(bAudit.every((e) => e.detail?.name !== "Alpha secret job")).toBe(true);
    expect(((await a.owner.get("/audit")).body as any[]).some((e) => e.action === "job.created")).toBe(true);
  });

  it("does not let a session from one company act in another by presenting its own token", async () => {
    const { a, b, jobId } = await twoCompanies();
    // Bravo's token with Alpha's job id in every position
    const c = new Client(s.app, b.owner.token);
    expect((await c.get(`/jobs/${jobId}`)).status).toBe(404);
    expect((await a.owner.get(`/jobs/${jobId}`)).status).toBe(200);
  });

  it("is enforced by the database too: a package cannot point at another company's job", async () => {
    const { b, jobId } = await twoCompanies();
    await expect(s.db.query("insert into packages (org_id, job_id, key, name, kind) values ($1, $2, 'x', 'x', 'x')", [b.orgId, jobId])).rejects.toThrow();
    const pkg = (await s.db.query<{ id: string }>("select id from packages where job_id = $1 limit 1", [jobId])).rows[0]!;
    await expect(s.db.query("insert into package_records (package_id, org_id, record_id, data) values ($1, $2, 'x', '{}')", [pkg.id, b.orgId])).rejects.toThrow();
    await expect(s.db.query("insert into locks (package_id, org_id, holder) values ($1, $2, $3)", [pkg.id, b.orgId, b.userId])).rejects.toThrow();
  });

  it("scopes a session to its company: a sign-in cannot be pointed at a company the person is not in", async () => {
    const { a, b } = await twoCompanies();
    const aEmail = (await a.owner.get("/me")).body.email as string;
    const r = await new Client(s.app).post("/auth/login", { email: aEmail, password: "correct horse battery", orgId: b.orgId });
    expect(r.status).toBe(401);
    expect(a.orgId).not.toBe(b.orgId);
  });
});
