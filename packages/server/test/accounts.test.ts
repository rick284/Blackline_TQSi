import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addPerson, Client, newCompany, PASSWORD, testServer, type TestServer } from "./helpers.js";

let s: TestServer;
beforeAll(async () => { s = await testServer(); });
afterAll(async () => { await s.close(); });

describe("accounts", () => {
  it("registers a company, signs its owner in, and knows who they are", async () => {
    const { owner } = await newCompany(s, "Acme Civil");
    const me = await owner.get("/me");
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ role: "owner", orgName: "Acme Civil" });
  });

  it("refuses requests with no or a bad token", async () => {
    expect((await new Client(s.app).get("/jobs")).status).toBe(401);
    expect((await new Client(s.app, "not-a-token").get("/jobs")).status).toBe(401);
    expect((await new Client(s.app).get("/health")).status).toBe(200);
  });

  it("rejects a weak password, a duplicate email and a bad email", async () => {
    const a = new Client(s.app);
    expect((await a.post("/auth/register", { orgName: "X", name: "X", email: "weak@x.test", password: "short" })).body.error.code).toBe("weak_password");
    await newCompany(s, "Dup Co", "dup@dup.test");
    expect((await a.post("/auth/register", { orgName: "Dup 2", name: "X", email: "DUP@dup.test", password: PASSWORD })).body.error.code).toBe("email_taken");
    expect((await a.post("/auth/register", { orgName: "X", name: "X", email: "not-an-email", password: PASSWORD })).status).toBe(400);
  });

  it("signs in with the right password only, and a logout ends the session", async () => {
    await newCompany(s, "Login Co", "login@login.test");
    const bad = await new Client(s.app).post("/auth/login", { email: "login@login.test", password: "wrong password!" });
    expect([bad.status, bad.body.error.code]).toEqual([401, "bad_credentials"]);
    expect((await new Client(s.app).post("/auth/login", { email: "nobody@login.test", password: PASSWORD })).status).toBe(401);
    const ok = await new Client(s.app).post("/auth/login", { email: "LOGIN@login.test", password: PASSWORD });
    expect(ok.status).toBe(200);
    const c = new Client(s.app, ok.body.token);
    expect((await c.get("/me")).status).toBe(200);
    expect((await c.post("/auth/logout")).status).toBe(204);
    expect((await c.get("/me")).status).toBe(401);
  });

  it("stores passwords hashed and session tokens as hashes", async () => {
    const { owner } = await newCompany(s, "Hash Co", "hash@hash.test");
    const row = (await s.db.query<{ password_hash: string }>("select password_hash from users where email = 'hash@hash.test'")).rows[0]!;
    expect(row.password_hash.startsWith("scrypt$")).toBe(true);
    expect(row.password_hash).not.toContain(PASSWORD);
    const tokens = (await s.db.query<{ token_hash: string }>("select token_hash from sessions")).rows.map((r) => r.token_hash);
    expect(tokens).not.toContain(owner.token);
  });
});

describe("roles", () => {
  it("lets an owner add people, a manager add only estimators and viewers, and a viewer only read", async () => {
    const { owner } = await newCompany(s, "Roles Co");
    const mgr = await addPerson(s, owner, "Maya", "manager");
    const est = await addPerson(s, owner, "Eli", "estimator");
    const view = await addPerson(s, owner, "Vic", "viewer");

    const addEst = await mgr.client.post("/org/members", { name: "New Est", email: "new.est@roles.test", password: PASSWORD, role: "estimator" });
    expect(addEst.status).toBe(201);
    const addMgr = await mgr.client.post("/org/members", { name: "Boss", email: "boss@roles.test", password: PASSWORD, role: "manager" });
    expect([addMgr.status, addMgr.body.error.code]).toEqual([403, "forbidden"]);
    expect((await est.client.post("/org/members", { name: "Z", email: "z@roles.test", password: PASSWORD, role: "viewer" })).status).toBe(403);

    expect((await est.client.post("/jobs", { name: "Estimator job" })).status).toBe(201);
    expect((await view.client.post("/jobs", { name: "Viewer job" })).status).toBe(403);
    expect((await view.client.get("/jobs")).status).toBe(200);

    const members = (await owner.get("/org/members")).body as { role: string }[];
    expect(members.map((m) => m.role).sort()).toEqual(["estimator", "estimator", "manager", "owner", "viewer"]);
    expect((await est.client.get("/audit")).status).toBe(403);
    expect((await mgr.client.get("/audit")).status).toBe(200);
  });

  it("puts one person in two companies and asks which to sign in to", async () => {
    const a = await newCompany(s, "Firm A", "shared@firms.test");
    const b = await newCompany(s, "Firm B", "bob@firmb.test");
    const added = await b.owner.post("/org/members", { name: "Shared", email: "shared@firms.test", password: PASSWORD, role: "estimator" });
    expect(added.status).toBe(201);
    const login = await new Client(s.app).post("/auth/login", { email: "shared@firms.test", password: PASSWORD });
    expect(login.body.choose.map((o: any) => o.name).sort()).toEqual(["Firm A", "Firm B"]);
    const inB = await new Client(s.app).post("/auth/login", { email: "shared@firms.test", password: PASSWORD, orgId: b.orgId });
    const me = (await new Client(s.app, inB.body.token).get("/me")).body;
    expect([me.orgName, me.role]).toEqual(["Firm B", "estimator"]);
    expect(a.orgId).not.toBe(b.orgId);
  });
});
