import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addPerson, jobWithEstimate, newCompany, testServer, type TestServer } from "./helpers.js";

let s: TestServer;
beforeAll(async () => { s = await testServer(); });
afterAll(async () => { await s.close(); });

async function company(name: string) {
  const { owner } = await newCompany(s, name);
  const est = await addPerson(s, owner, "Eli", "estimator");
  const vic = await addPerson(s, owner, "Vic", "viewer");
  return { owner, est: est.client, vic: vic.client };
}

describe("starting a blank tender", () => {
  it("is open to an estimator, builds the standard packages, and the estimate calculates (to nothing)", async () => {
    const c = await company("Blank Co");
    const job = (await c.est.post("/jobs", { name: "New school", client: "Council" })).body;
    expect((await c.vic.post(`/jobs/${job.id}/template`, {})).status).toBe(403);
    const r = await c.est.post(`/jobs/${job.id}/template`, { overheadPct: "12", profitPct: "8" });
    expect([r.status, r.body.packages]).toEqual([201, 7]);
    const pkgs = (await c.owner.get(`/jobs/${job.id}/packages`)).body as { key: string }[];
    expect(pkgs.map((p) => p.key).sort()).toEqual(["commercial", "library", "narrative", "programme", "risk", "settings", "subcontracts"]);
    const recs = (await c.owner.get(`/jobs/${job.id}/records`)).body.records as { id: string; data: any }[];
    expect(recs.find((x) => x.id === "ca:CA17")!.data.body).toMatchObject({ pct: "0.12", include: "Yes" });
    expect(recs.find((x) => x.id === "ca:CA18")!.data.body).toMatchObject({ pct: "0.08" });
    const est = (await c.owner.get(`/jobs/${job.id}/estimate`)).body;
    expect(est).toBeTruthy();
    const audit = (await c.owner.get("/audit")).body as any[];
    expect(audit.some((a) => a.action === "job.template")).toBe(true);
  });

  it("uses overhead 10% and profit 15% when none are given, and refuses nonsense", async () => {
    const c = await company("Default Co");
    const a = (await c.est.post("/jobs", { name: "A" })).body, b = (await c.est.post("/jobs", { name: "B" })).body;
    expect((await c.est.post(`/jobs/${a.id}/template`, {})).status).toBe(201);
    const ca = ((await c.owner.get(`/jobs/${a.id}/records`)).body.records as any[]);
    expect([ca.find((x) => x.id === "ca:CA17")!.data.body.pct, ca.find((x) => x.id === "ca:CA18")!.data.body.pct]).toEqual(["0.1", "0.15"]);
    expect((await c.est.post(`/jobs/${b.id}/template`, { profitPct: "100" })).body.error.message).toContain("can't be more than 60%");
    expect((await c.est.post(`/jobs/${b.id}/template`, { overheadPct: "lots" })).status).toBe(400);
  });

  it("only for a job with nothing in it", async () => {
    const c = await company("Full Co");
    const { jobId } = await jobWithEstimate(s, c.owner);
    const r = await c.est.post(`/jobs/${jobId}/template`, {});
    expect([r.status, r.body.error.code]).toEqual([409, "job_not_empty"]);
    const blank = (await c.est.post("/jobs", { name: "Once" })).body;
    await c.est.post(`/jobs/${blank.id}/template`, {});
    expect((await c.est.post(`/jobs/${blank.id}/template`, {})).body.error.code).toBe("job_not_empty");
  });

  it("belongs to its company", async () => {
    const a = await company("Mine Co"), b = await company("Theirs Co");
    const job = (await a.est.post("/jobs", { name: "Mine" })).body;
    expect((await b.owner.post(`/jobs/${job.id}/template`, {})).status).toBe(404);
    expect((await b.owner.post(`/jobs/${job.id}/sections`, { name: "Earthworks" })).status).toBe(404);
  });
});

describe("adding a QS section", () => {
  it("makes a package of its own that can be checked out, with a tidy unique name", async () => {
    const c = await company("Section Co");
    const job = (await c.est.post("/jobs", { name: "J" })).body;
    await c.est.post(`/jobs/${job.id}/template`, {});
    expect((await c.vic.post(`/jobs/${job.id}/sections`, { name: "Earthworks" })).status).toBe(403);
    const r = await c.est.post(`/jobs/${job.id}/sections`, { name: "  Pipes   and drainage " });
    expect([r.status, r.body.name, r.body.created]).toEqual([201, "Pipes and drainage", true]);
    const pkg = ((await c.owner.get(`/jobs/${job.id}/packages`)).body as any[]).find((p) => p.key === "qs:Pipes and drainage");
    expect(pkg).toMatchObject({ kind: "qs-section", name: "Pipes and drainage", records: 0 });
    // it is held and filled like any section
    expect((await c.est.post(`/packages/${pkg.id}/checkout`)).status).toBe(200);
    const item = { kind: "qs", seq: 1, body: { code: "PD01", section: "Pipes and drainage", description: "300 dia stormwater", unit: "m", quantity: "120" } };
    expect((await c.est.post(`/packages/${pkg.id}/checkin`, { baseVersion: 1, upserts: { "qs:PD01": item }, deletes: [] })).status).toBe(200);
    const est = (await c.owner.get(`/jobs/${job.id}/estimate`)).body;
    expect(JSON.stringify(est)).toContain("PD01");
  });

  it("refuses a repeat (any capitals), a blank, and the name kept for orphan rows", async () => {
    const c = await company("Dup Co");
    const job = (await c.est.post("/jobs", { name: "J" })).body;
    await c.est.post(`/jobs/${job.id}/sections`, { name: "Earthworks" });
    for (const [name, text] of [["earthworks", "already a section"], ["   ", "Name the section"], ["Unassigned rows", "no QS item"]] as const) {
      const r = await c.est.post(`/jobs/${job.id}/sections`, { name });
      expect([name, r.status, r.body.error.message.includes(text)]).toEqual([name, 400, true]);
    }
  });
});
