/**
 * End to end on the real Hobsonville Rev34E workbook: upload it, store it as lockable packages, recalculate it on the server from the
 * database, and get the workbook's own all-in tender to the cent. Skipped when private/Rev34E.xlsx is absent.
 */
import { existsSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addPerson, newCompany, testServer, type TestServer } from "./helpers.js";

const FILE = new URL("../../../private/Rev34E.xlsx", import.meta.url);
let s: TestServer;
beforeAll(async () => { s = await testServer(); });
afterAll(async () => { await s.close(); });

describe("workbook import", () => {
  it("rejects a file that is not a workbook, and a missing body", async () => {
    const { owner } = await newCompany(s, "Bad File Co");
    const job = (await owner.post("/jobs", { name: "J" })).body.id;
    const bad = await owner.call("POST", `/jobs/${job}/import-workbook`, undefined, { raw: Buffer.from("this is not a zip") });
    expect([bad.status, bad.body.error.code]).toEqual([422, "unreadable_workbook"]);
    expect((await owner.post(`/jobs/${job}/import-workbook`, {})).status).toBe(415);
  });
});

describe.skipIf(!existsSync(FILE))("Hobsonville Rev34E through the server", () => {
  it("imports, stores as packages, and recalculates to the workbook's all-in tender", async () => {
    const { owner } = await newCompany(s, "Hobsonville Co");
    const est = await addPerson(s, owner, "Eli", "estimator");
    const mgr = await addPerson(s, owner, "Maya", "manager");
    const job = (await owner.post("/jobs", { name: "329 Hobsonville Road", client: "TPW" })).body.id;
    const bytes = readFileSync(FILE);

    expect((await est.client.call("POST", `/jobs/${job}/import-workbook`, undefined, { raw: bytes })).status).toBe(403); // managers import
    const imp = await mgr.client.call("POST", `/jobs/${job}/import-workbook`, undefined, { raw: bytes });
    expect(imp.status).toBe(201);
    expect(imp.body.packages).toBeGreaterThan(10);
    expect((await mgr.client.call("POST", `/jobs/${job}/import-workbook`, undefined, { raw: bytes })).body.error.code).toBe("job_not_empty");

    const pkgs = (await owner.get(`/jobs/${job}/packages`)).body as { key: string; name: string; records: number }[];
    expect(pkgs.filter((p) => p.key.startsWith("qs:")).map((p) => p.name)).toContain("Earthworks");

    const calc = (await owner.get(`/jobs/${job}/estimate`)).body;
    const e = calc.estimate;
    expect(Number(e.qs.totalDirect).toFixed(2)).toBe("435521.88");
    expect(Number(e.tender.tenderExclGst).toFixed(2)).toBe("614700.22");
    expect(Number(e.consolidated.allInTender).toFixed(2)).toBe("1226916.81");
    expect(e.reconciled).toBe(true);
    expect(e.schedule.reconciles).toBe(true);
  });

  it("changing one section through checkout moves the price, and only that section was locked", async () => {
    const { owner } = await newCompany(s, "Hobsonville Two");
    const carlo = await addPerson(s, owner, "Carlo", "estimator");
    const job = (await owner.post("/jobs", { name: "Hobsonville copy" })).body.id;
    await owner.call("POST", `/jobs/${job}/import-workbook`, undefined, { raw: readFileSync(FILE) });
    const pkgs = (await owner.get(`/jobs/${job}/packages`)).body as { id: string; key: string }[];
    const ew = pkgs.find((p) => p.key === "qs:Earthworks")!;
    const before = Number((await owner.get(`/jobs/${job}/estimate`)).body.estimate.consolidated.allInTender);

    const out = await carlo.client.post(`/packages/${ew.id}/checkout`);
    expect(out.status).toBe(200);
    const row = Object.entries(out.body.records as Record<string, any>).find(([, r]) => r.kind === "row" && Number(r.body.jobRateOverride ?? 0) > 0)!;
    const [rowId, rec] = row;
    const bumped = { ...rec, body: { ...rec.body, jobRateOverride: String(Number(rec.body.jobRateOverride) + 100) } };
    expect((await carlo.client.post(`/packages/${ew.id}/checkin`, { baseVersion: out.body.version, upserts: { [rowId]: bumped }, deletes: [] })).status).toBe(200);

    const after = Number((await owner.get(`/jobs/${job}/estimate`)).body.estimate.consolidated.allInTender);
    expect(after).toBeGreaterThan(before);
    const others = ((await owner.get(`/jobs/${job}/packages`)).body as any[]).filter((p) => p.id !== ew.id);
    expect(others.every((p) => p.lock === null && p.version === 1)).toBe(true);
  });
});
