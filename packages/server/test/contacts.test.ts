import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addPerson, newCompany, testServer, type TestServer } from "./helpers.js";

let s: TestServer;
beforeAll(async () => { s = await testServer(); });
afterAll(async () => { await s.close(); });

async function company(name: string) {
  const { owner } = await newCompany(s, name);
  const mgr = await addPerson(s, owner, "Maya", "manager");
  const est = await addPerson(s, owner, "Eli", "estimator");
  const vic = await addPerson(s, owner, "Vic", "viewer");
  return { owner, mgr, est, vic };
}

describe("contacts", () => {
  it("are added by an estimator, listed by name, and one entry per company and kind", async () => {
    const c = await company("Contacts Co");
    expect((await c.vic.client.post("/contacts", { name: "Nope", kind: "client" })).status).toBe(403);
    const a = await c.est.client.post("/contacts", { name: "TPW Construction", kind: "client", person: "Dave Stewart", phone: "021 555 0100", email: "dave@tpw.test" });
    expect([a.status, a.body.name, a.body.kind, a.body.person, a.body.jobs]).toEqual([201, "TPW Construction", "client", "Dave Stewart", 0]);
    await c.est.client.post("/contacts", { name: "Allied Drainage", kind: "subcontractor", trade: "Drainage" });
    expect(((await c.vic.client.get("/contacts")).body as any[]).map((x) => x.name)).toEqual(["Allied Drainage", "TPW Construction"]);
    expect((await c.est.client.post("/contacts", { name: "tpw construction", kind: "client" })).body.error.code).toBe("contact_exists");
    expect((await c.est.client.post("/contacts", { name: "TPW Construction", kind: "supplier" })).status).toBe(201); // same company, another kind
  });

  it("refuse a blank name, an unknown kind and an email that isn't one", async () => {
    const c = await company("Checks Co");
    expect((await c.est.client.post("/contacts", { name: "  ", kind: "client" })).status).toBe(400);
    expect((await c.est.client.post("/contacts", { name: "X", kind: "friend" })).body.error.message).toContain("Kind must be");
    expect((await c.est.client.post("/contacts", { name: "X", kind: "client", email: "not an email" })).body.error.message).toContain("email");
    expect((await c.est.client.post("/contacts", { name: "X" })).status).toBe(400);
  });

  it("keep the earlier value when a field is edited, and record nothing when nothing changed", async () => {
    const c = await company("History Co");
    const made = (await c.est.client.post("/contacts", { name: "Coast Concrete", kind: "subcontractor", phone: "09 111 1111" })).body;
    const edited = await c.mgr.client.post(`/contacts/${made.id}`, { phone: "09 222 2222", notes: "Prefers email" });
    expect([edited.body.phone, edited.body.notes]).toEqual(["09 222 2222", "Prefers email"]);
    await c.mgr.client.post(`/contacts/${made.id}`, { phone: "09 222 2222" });
    const hist = (await c.owner.get(`/contacts/${made.id}/history`)).body as any[];
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({ by: "Maya", changes: { phone: { from: "09 111 1111", to: "09 222 2222" }, notes: { from: "", to: "Prefers email" } } });
    expect((await c.vic.client.post(`/contacts/${made.id}`, { phone: "1" })).status).toBe(403);
  });

  it("are archived, not deleted, and come back when restored", async () => {
    const c = await company("Archive Co");
    const made = (await c.est.client.post("/contacts", { name: "Old Supplier", kind: "supplier" })).body;
    expect((await c.est.client.post(`/contacts/${made.id}/archive`)).body.archived_at).not.toBeNull();
    expect((await c.owner.get("/contacts")).body).toHaveLength(0);
    expect((await c.owner.get("/contacts?archived=1")).body).toHaveLength(1);
    expect((await c.est.client.post(`/contacts/${made.id}/restore`)).body.archived_at).toBeNull();
    expect((await c.owner.get("/contacts")).body).toHaveLength(1);
  });

  it("belong to their company: another company gets the same 404 as for a made-up id", async () => {
    const a = await company("Mine Co"), b = await company("Theirs Co");
    const made = (await a.est.client.post("/contacts", { name: "Secret Client", kind: "client" })).body;
    expect((await b.owner.get("/contacts")).body).toHaveLength(0);
    for (const [m, url] of [["POST", `/contacts/${made.id}`], ["POST", `/contacts/${made.id}/archive`], ["GET", `/contacts/${made.id}/history`]] as const) {
      expect([url, (await b.owner.call(m, url, {})).status]).toEqual([url, 404]);
    }
    const job = (await b.owner.post("/jobs", { name: "Their job" })).body;
    expect((await b.owner.post(`/jobs/${job.id}/enquiry`, { contactId: made.id })).body.error.message).toContain("isn't in your company");
  });
});

describe("the enquiry register", () => {
  it("is the job record: client, owner, due date, value and note are set on it, and the client follows the contact's name", async () => {
    const c = await company("Register Co");
    const client = (await c.est.client.post("/contacts", { name: "TPW", kind: "client" })).body;
    const job = (await c.est.client.post("/jobs", { name: "329 Hobsonville Road", contactId: client.id, dueAt: "2026-11-12", notes: "Phone call Tuesday", approxValue: "$1,250,000" })).body;
    expect(job).toMatchObject({ status: "enquiry", client: "TPW", contact_id: client.id, notes: "Phone call Tuesday", approx_value: "1250000" });
    expect(new Date(job.due_at).toISOString().slice(0, 10)).toBe("2026-11-12");
    await c.est.client.post(`/contacts/${client.id}`, { name: "TPW Construction" });
    expect((await c.owner.get(`/jobs/${job.id}`)).body.client).toBe("TPW Construction");
    const edit = await c.est.client.post(`/jobs/${job.id}/enquiry`, { ownerId: c.est.userId });
    expect(edit.body).toMatchObject({ owner_id: c.est.userId, owner_name: "Eli" });
    const cleared = await c.est.client.post(`/jobs/${job.id}/enquiry`, { contactId: null, dueAt: null });
    expect([cleared.body.contact_id, cleared.body.due_at]).toEqual([null, null]);
  });

  it("refuses an owner from another company, a bad date and a bad value", async () => {
    const c = await company("Bad Co"), other = await company("Other Co");
    const job = (await c.est.client.post("/jobs", { name: "J" })).body;
    expect((await c.est.client.post(`/jobs/${job.id}/enquiry`, { ownerId: other.est.userId })).body.error.message).toContain("someone in your company");
    expect((await c.est.client.post(`/jobs/${job.id}/enquiry`, { dueAt: "next week" })).status).toBe(400);
    expect((await c.est.client.post(`/jobs/${job.id}/enquiry`, { approxValue: "a lot" })).status).toBe(400);
    expect((await c.vic.client.post(`/jobs/${job.id}/enquiry`, { notes: "x" })).status).toBe(403);
  });

  it("goes to tender only with an owner and a deadline, and only a manager decides", async () => {
    const c = await company("Go Co");
    const job = (await c.est.client.post("/jobs", { name: "Go job" })).body;
    expect((await c.est.client.post(`/jobs/${job.id}/decision`, { decision: "go" })).status).toBe(403);
    const early = await c.mgr.client.post(`/jobs/${job.id}/decision`, { decision: "go" });
    expect([early.status, early.body.error.code]).toEqual([409, "enquiry_incomplete"]);
    await c.est.client.post(`/jobs/${job.id}/enquiry`, { ownerId: c.est.userId, dueAt: "2026-12-01" });
    const go = await c.mgr.client.post(`/jobs/${job.id}/decision`, { decision: "go" });
    expect([go.status, go.body.status]).toEqual([200, "tender"]);
    expect((await c.mgr.client.post(`/jobs/${job.id}/decision`, { decision: "go" })).body.error.code).toBe("wrong_stage");
  });

  it("logs a no bid with its reason, and a reason is required", async () => {
    const c = await company("NoBid Co");
    const job = (await c.est.client.post("/jobs", { name: "Too far" })).body;
    expect((await c.mgr.client.post(`/jobs/${job.id}/decision`, { decision: "no-bid" })).body.error.message).toContain("why");
    const nb = await c.mgr.client.post(`/jobs/${job.id}/decision`, { decision: "no-bid", reason: "Too far from our crews" });
    expect([nb.body.status, nb.body.decision_reason]).toEqual(["no-bid", "Too far from our crews"]);
    const audit = (await c.owner.get("/audit")).body as any[];
    expect(audit.find((a) => a.action === "enquiry.no-bid").detail).toMatchObject({ from: "enquiry", to: "no-bid", reason: "Too far from our crews" });
    const back = await c.mgr.client.post(`/jobs/${job.id}/decision`, { decision: "reopen" });
    expect([back.body.status, back.body.decision_reason]).toEqual(["enquiry", ""]);
    expect((await c.mgr.client.post(`/jobs/${job.id}/decision`, { decision: "reopen" })).body.error.code).toBe("wrong_stage");
  });

  it("marks only an issued tender lost, with a reason", async () => {
    const c = await company("Lost Co");
    const job = (await c.est.client.post("/jobs", { name: "Lost job" })).body;
    expect((await c.mgr.client.post(`/jobs/${job.id}/decision`, { decision: "lost", reason: "Price" })).body.error.code).toBe("wrong_stage");
    await s.db.query("update jobs set status = 'issued' where id = $1", [job.id]);
    expect((await c.mgr.client.post(`/jobs/${job.id}/decision`, { decision: "lost" })).status).toBe(400);
    expect((await c.mgr.client.post(`/jobs/${job.id}/decision`, { decision: "lost", reason: "Beaten on price by 4%" })).body).toMatchObject({ status: "lost", decision_reason: "Beaten on price by 4%" });
  });
});
