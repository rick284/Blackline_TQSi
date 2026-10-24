/** The company resource library and the register's housekeeping: archive, restore, copy and delete. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addPerson, newCompany, testServer, type TestServer } from "./helpers.js";

let s: TestServer;
beforeAll(async () => { s = await testServer(); });
afterAll(async () => { await s.close(); });

describe("company resource library", () => {
  it("adds, edits and lists rates; codes are unique ignoring capitals; only a manager deletes", async () => {
    const { owner } = await newCompany(s, "Library Co");
    const est = await addPerson(s, owner, "Eli", "estimator");
    const mgr = await addPerson(s, owner, "Maya", "manager");

    const a = await est.client.post("/rates", { code: "LAB-CARP", category: "Labour", description: "Carpenter", unit: "hr", baseRate: "85.5" });
    expect([a.status, a.body.baseRate]).toEqual([201, "85.5"]);
    expect((await est.client.post("/rates", { code: "lab-carp" })).body.error.code).toBe("rate_exists");
    expect((await est.client.post("/rates", { code: "bad code!" })).status).toBe(400);
    expect((await est.client.post("/rates", { code: "X1", baseRate: "abc" })).status).toBe(400);

    const up = await est.client.post(`/rates/${a.body.id}`, { baseRate: 90, description: "Carpenter (qualified)" });
    expect([up.status, up.body.baseRate, up.body.description]).toEqual([200, "90", "Carpenter (qualified)"]);

    const bulk = await est.client.post("/rates/bulk", { rates: [{ code: "LAB-CARP", baseRate: "1" }, { code: "PL-EXC20", category: "Plant", unit: "hr", baseRate: "140" }] });
    expect(bulk.body).toEqual({ added: 1, skipped: 1 });
    expect(((await est.client.get("/rates")).body as any[]).map((r) => r.code)).toEqual(["LAB-CARP", "PL-EXC20"]);

    expect((await est.client.post(`/rates/${a.body.id}/delete`)).status).toBe(403);
    expect((await mgr.client.post(`/rates/${a.body.id}/delete`)).status).toBe(204);
    expect((await owner.get("/rates")).body).toHaveLength(1);
  });

  it("is private to the company", async () => {
    const a = await newCompany(s, "Lib A");
    const b = await newCompany(s, "Lib B");
    const r = await a.owner.post("/rates", { code: "ONLY-A" });
    expect((await b.owner.get("/rates")).body).toEqual([]);
    expect((await b.owner.post(`/rates/${r.body.id}`, { description: "x" })).status).toBe(404);
    expect((await b.owner.post(`/rates/${r.body.id}/delete`)).status).toBe(404);
  });
});

describe("tender register housekeeping", () => {
  it("archives and restores; archived jobs leave the default list", async () => {
    const { owner } = await newCompany(s, "Archive Co");
    const job = (await owner.post("/jobs", { name: "Old job" })).body.id;
    expect((await owner.post(`/jobs/${job}/archive`)).body.archived_at).toBeTruthy();
    expect((await owner.get("/jobs")).body).toHaveLength(0);
    expect((await owner.get("/jobs?archived=1")).body).toHaveLength(1);
    expect((await owner.post(`/jobs/${job}/restore`)).body.archived_at).toBeNull();
    expect((await owner.get("/jobs")).body).toHaveLength(1);
  });

  it("deletes a job (manager), refuses while a package is held, and copies a job without locks", async () => {
    const { owner } = await newCompany(s, "Delete Co");
    const est = await addPerson(s, owner, "Eli", "estimator");
    const job = (await owner.post("/jobs", { name: "Draft tender" })).body.id;
    await owner.post(`/jobs/${job}/template`, { overheadPct: "10", profitPct: "15" });
    await owner.post(`/jobs/${job}/sections`, { name: "Earthworks" });
    const pkgs = (await owner.get(`/jobs/${job}/packages`)).body as { id: string; key: string; kind: string }[];
    expect(pkgs.length).toBeGreaterThan(3);
    expect(pkgs.filter((p) => p.kind === "library")).toHaveLength(1); // a blank tender still has its Rate Library, so rates can be added to it

    const copy = await owner.post(`/jobs/${job}/copy`, { name: "Draft tender (copy)" });
    expect(copy.status).toBe(201);
    const copied = (await owner.get(`/jobs/${copy.body.id}/packages`)).body as { key: string; lock: unknown }[];
    expect(copied.map((p) => p.key).sort()).toEqual(pkgs.map((p) => p.key).sort());
    expect(copied.every((p) => p.lock === null)).toBe(true);
    expect((await owner.post(`/jobs/${job}/copy`, { name: "Draft tender (copy)" })).body.error.code).toBe("job_exists");

    expect((await est.client.post(`/jobs/${job}/delete`)).status).toBe(403);
    const ew = pkgs.find((p) => p.key === "qs:Earthworks")!;
    expect((await est.client.post(`/packages/${ew.id}/checkout`)).status).toBe(200);
    expect((await owner.post(`/jobs/${job}/delete`)).body.error.code).toBe("job_in_use");
    await est.client.post(`/packages/${ew.id}/release`);
    expect((await owner.post(`/jobs/${job}/delete`)).status).toBe(204);
    expect((await owner.get("/jobs")).body.map((j: any) => j.name)).toEqual(["Draft tender (copy)"]);
    expect((await owner.get(`/jobs/${job}/packages`)).status).toBe(404);
  });
});
