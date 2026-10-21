import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addPerson, jobWithEstimate, newCompany, testServer, type Client, type TestServer } from "./helpers.js";

let s: TestServer;
beforeAll(async () => { s = await testServer(); });
afterAll(async () => { await s.close(); });

const download = async (c: Client, url: string) => {
  const res = await s.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${c.token}` } });
  return { status: res.statusCode, body: res.rawPayload, type: String(res.headers["content-type"] ?? ""), disp: String(res.headers["content-disposition"] ?? ""), json: res.statusCode >= 400 ? JSON.parse(res.body) : null };
};
const allIn = async (buf: Buffer) => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as never);
  let v = 0;
  wb.getWorksheet("Summary")!.eachRow((r) => { if (r.getCell(1).value === "Working all-in tender excl. GST") v = Number(r.getCell(2).value); });
  return v;
};

async function company(name: string) {
  const { owner } = await newCompany(s, name);
  const est = await addPerson(s, owner, "Eli", "estimator");
  const vic = await addPerson(s, owner, "Vic", "viewer");
  const { jobId, byKey } = await jobWithEstimate(s, owner, "329 Hobsonville Rd / Stage 1");
  return { owner, est: est.client, vic: vic.client, jobId, byKey };
}

describe("the estimate as Excel", () => {
  it("is a workbook anyone in the company can download, named for the job", async () => {
    const t = await company("Excel Co");
    const r = await download(t.vic, `/jobs/${t.jobId}/export/estimate.xlsx`);
    expect(r.status).toBe(200);
    expect(r.type).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(r.disp).toContain('filename="329 Hobsonville Rd Stage 1 - working copy - estimate.xlsx"');
    expect(r.body.subarray(0, 2).toString()).toBe("PK"); // a zip, as xlsx is
    expect(await allIn(r.body)).toBeGreaterThan(14000);
  });

  it("an issued revision's workbook stays as it was sent while the job moves on", async () => {
    const t = await company("Frozen Excel Co");
    const rev = (await t.owner.post(`/jobs/${t.jobId}/revisions`, { overrideReason: "Test" })).body;
    const before = await allIn((await download(t.vic, `/revisions/${rev.id}/export/estimate.xlsx`)).body);
    expect(before).toBeCloseTo(Number(rev.totals.allIn), 2);
    // the live job changes: a different price on an earthworks row
    expect((await t.est.post(`/packages/${t.byKey["qs:Earthworks"]}/checkout`)).status).toBe(200);
    const live = (await t.est.get(`/jobs/${t.jobId}/records`)).body.records.find((x: any) => x.id === "row:EW01-001");
    const changed = { ...live.data, body: { ...live.data.body, jobRateOverride: "99999" } };
    expect((await t.est.post(`/packages/${t.byKey["qs:Earthworks"]}/checkin`, { baseVersion: 1, upserts: { "row:EW01-001": changed }, deletes: [] })).status).toBe(200);
    const nowLive = await allIn((await download(t.owner, `/jobs/${t.jobId}/export/estimate.xlsx`)).body);
    const stillRevision = await allIn((await download(t.owner, `/revisions/${rev.id}/export/estimate.xlsx`)).body);
    expect(nowLive).toBeGreaterThan(before + 50000);
    expect(stillRevision).toBe(before);
    expect((await download(t.owner, `/revisions/${rev.id}/export/estimate.xlsx`)).disp).toContain("Rev A - estimate.xlsx");
  });

  it("is refused for a job with nothing in it", async () => {
    const t = await company("Empty Co");
    const blank = (await t.est.post("/jobs", { name: "Blank" })).body;
    const r = await download(t.est, `/jobs/${blank.id}/export/estimate.xlsx`);
    expect([r.status, r.json.error.code]).toEqual([409, "empty_job"]);
  });
});

describe("the tender letter as PDF", () => {
  it("needs the letter to have been started, then is a PDF for the job or for a revision", async () => {
    const t = await company("PDF Co");
    const none = await download(t.est, `/jobs/${t.jobId}/export/letter.pdf`);
    expect([none.status, none.json.error.code]).toEqual([409, "no_letter"]);
    expect((await t.est.post(`/jobs/${t.jobId}/submission`, {})).status).toBe(201);
    const live = await download(t.vic, `/jobs/${t.jobId}/export/letter.pdf`);
    expect([live.status, live.type, live.body.subarray(0, 5).toString()]).toEqual([200, "application/pdf", "%PDF-"]);
    expect(live.disp).toContain("working copy - tender letter.pdf");
    const rev = (await t.owner.post(`/jobs/${t.jobId}/revisions`, { overrideReason: "Test" })).body;
    const sent = await download(t.vic, `/revisions/${rev.id}/export/letter.pdf`);
    expect([sent.status, sent.body.subarray(0, 5).toString()]).toEqual([200, "%PDF-"]);
    expect(sent.disp).toContain("Rev A - tender letter.pdf");
  });

  it("a revision issued before any letter was written has none to give", async () => {
    const t = await company("No Letter Co");
    const rev = (await t.owner.post(`/jobs/${t.jobId}/revisions`, { overrideReason: "Test" })).body;
    const r = await download(t.est, `/revisions/${rev.id}/export/letter.pdf`);
    expect([r.status, r.json.error.code]).toEqual([409, "no_letter"]);
  });
});

describe("files belong to their company", () => {
  it("another company gets 404 for every one, and a made-up id is the same 404", async () => {
    const a = await company("Mine Co"), b = await newCompany(s, "Theirs Co");
    await a.est.post(`/jobs/${a.jobId}/submission`, {});
    const rev = (await a.owner.post(`/jobs/${a.jobId}/revisions`, { overrideReason: "Test" })).body;
    for (const url of [`/jobs/${a.jobId}/export/estimate.xlsx`, `/jobs/${a.jobId}/export/letter.pdf`, `/revisions/${rev.id}/export/estimate.xlsx`, `/revisions/${rev.id}/export/letter.pdf`]) {
      expect([url, (await download(b.owner, url)).status]).toEqual([url, 404]);
    }
    expect((await download(b.owner, "/revisions/00000000-0000-4000-8000-000000000000/export/letter.pdf")).status).toBe(404);
    expect((await download(a.owner, "/revisions/not-an-id/export/letter.pdf")).status).toBe(404);
  });
});
