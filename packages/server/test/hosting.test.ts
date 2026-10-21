import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp, clientIp, type AppOptions } from "../src/app.js";
import { flags, run } from "../src/admin.js";
import { type Db, migrate, openPglite } from "../src/db.js";
import { RateLimiter } from "../src/ratelimit.js";
import { Client, PASSWORD } from "./helpers.js";

vi.setConfig({ testTimeout: 30_000 }); // each of these starts its own database and hashes passwords

let db: Db;
beforeAll(async () => { db = await openPglite(); await migrate(db); });
afterAll(async () => { await db.close(); });

const reg = (c: Client, n: string) => c.post("/auth/register", { orgName: n, name: `${n} Owner`, email: `o@${n.toLowerCase().replace(/\W/g, "")}.test`, password: PASSWORD });

describe("RateLimiter", () => {
  it("allows `max` attempts in the window, says when to retry, and forgets old ones", () => {
    let t = 0;
    const l = new RateLimiter(3, 60_000, () => t);
    expect([l.hit("a").ok, l.hit("a").ok, l.hit("a").ok]).toEqual([true, true, true]);
    t = 10_000;
    expect(l.hit("a")).toEqual({ ok: false, retryAfterSec: 50 });
    expect(l.hit("b").ok).toBe(true); // keys are separate
    t = 61_000;
    expect(l.hit("a").ok).toBe(true);
    l.reset("a");
    expect([l.hit("a").ok, l.hit("a").ok, l.hit("a").ok]).toEqual([true, true, true]);
  });
});

describe("who can start a company", () => {
  it("'first' lets the first company register and then closes the door", async () => {
    const d = await openPglite(); await migrate(d);
    const app = buildApp(d, { registration: "first" }); await app.ready();
    const c = new Client(app);
    expect((await c.get("/auth/status")).body).toEqual({ registration: true });
    expect((await reg(c, "First Co")).status).toBe(201);
    expect((await c.get("/auth/status")).body).toEqual({ registration: false });
    const second = await reg(c, "Second Co");
    expect([second.status, second.body.error.code]).toEqual([403, "registration_closed"]);
    await app.close(); await d.close();
  });

  it("'closed' never lets anyone register, but people can still sign in", async () => {
    const d = await openPglite(); await migrate(d);
    await run(d, "create-company", { org: "Admin Co", name: "Ada", email: "ada@admin.test", password: PASSWORD });
    const app = buildApp(d, { registration: "closed" }); await app.ready();
    const c = new Client(app);
    expect((await c.get("/auth/status")).body).toEqual({ registration: false });
    expect((await reg(c, "Nope Co")).status).toBe(403);
    expect((await c.post("/auth/login", { email: "ada@admin.test", password: PASSWORD })).status).toBe(200);
    await app.close(); await d.close();
  });
});

describe("clientIp", () => {
  it("counts from the proxy end of X-Forwarded-For", () => {
    expect(clientIp("9.9.9.9, 203.0.113.5", "10.0.0.1", 1)).toBe("203.0.113.5");
    expect(clientIp("9.9.9.9, 203.0.113.5, 10.1.1.1", "10.0.0.1", 2)).toBe("203.0.113.5");
    expect(clientIp("203.0.113.5", "10.0.0.1", 2)).toBe("203.0.113.5"); // fewer entries than proxies: the first one
    expect(clientIp("9.9.9.9", "10.0.0.1", 0)).toBe("10.0.0.1");        // no proxy: a header means nothing
    expect(clientIp(undefined, "10.0.0.1", 1)).toBe("10.0.0.1");
  });
});

describe("rate limiting", () => {
  it("slows guessing one person's password, and a good sign-in clears the count", async () => {
    const d = await openPglite(); await migrate(d);
    await run(d, "create-company", { org: "Lim Co", name: "Lee", email: "lee@lim.test", password: PASSWORD });
    const app = buildApp(d, { rateLimit: { loginPerEmail: 3, loginPerIp: 100 } }); await app.ready();
    const c = new Client(app);
    const bad = () => c.post("/auth/login", { email: "lee@lim.test", password: "not the password" });
    expect((await bad()).status).toBe(401);
    expect((await bad()).status).toBe(401);
    expect((await c.post("/auth/login", { email: "LEE@lim.test", password: PASSWORD })).status).toBe(200); // clears the count (any capitals)
    for (let i = 0; i < 3; i++) expect((await bad()).status).toBe(401);
    const blocked = await bad();
    expect([blocked.status, blocked.body.error.code]).toEqual([429, "too_many_attempts"]);
    expect(blocked.body.error.message).toMatch(/Try again in/);
    // even the right password waits
    expect((await c.post("/auth/login", { email: "lee@lim.test", password: PASSWORD })).status).toBe(429);
    await app.close(); await d.close();
  });

  it("counts the address the host's proxy saw, not one a visitor made up", async () => {
    const d = await openPglite(); await migrate(d);
    const app = buildApp(d, { rateLimit: { registerPerIp: 1 }, trustProxy: 1 }); await app.ready();
    const go = (fwd: string, n: string) => app.inject({ method: "POST", url: "/auth/register", headers: { "x-forwarded-for": fwd }, payload: { orgName: n, name: "N", email: `${n}@x.test`, password: PASSWORD } });
    expect((await go("9.9.9.9, 203.0.113.5", "a")).statusCode).toBe(201);
    expect((await go("8.8.8.8, 203.0.113.5", "b")).statusCode).toBe(429); // same real visitor, different made-up first entry
    expect((await go("8.8.8.8, 203.0.113.6", "c")).statusCode).toBe(201); // a different real visitor
    await app.close(); await d.close();
  });

  it("limits sign-ups from one address", async () => {
    const d = await openPglite(); await migrate(d);
    const app = buildApp(d, { rateLimit: { registerPerIp: 2 } }); await app.ready();
    const c = new Client(app);
    expect((await reg(c, "A Co")).status).toBe(201);
    expect((await reg(c, "B Co")).status).toBe(201);
    expect((await reg(c, "C Co")).status).toBe(429);
    await app.close(); await d.close();
  });
});

describe("serving the web app", () => {
  let dir: string;
  const opts = (): AppOptions => ({ webDir: dir, secureHeaders: true, registration: "open" });
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "bl-web-"));
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>Blackline</title><div id=root></div>");
    writeFileSync(join(dir, "assets", "app-abc123.js"), "console.log(1)");
    writeFileSync(join(dir, "sw.js"), "// worker");
    writeFileSync(join(dir, "..", "bl-secret.txt"), "outside");
  });

  it("serves the page, the built files with the right caching, and the page for any other address", async () => {
    const app = buildApp(db, opts()); await app.ready();
    const page = await app.inject({ method: "GET", url: "/" });
    expect([page.statusCode, page.headers["content-type"], page.headers["cache-control"]]).toEqual([200, "text/html; charset=utf-8", "no-cache"]);
    expect(page.body).toContain("<title>Blackline</title>");
    const js = await app.inject({ method: "GET", url: "/assets/app-abc123.js" });
    expect([js.statusCode, js.headers["content-type"], js.headers["cache-control"]]).toEqual([200, "text/javascript; charset=utf-8", "public, max-age=31536000, immutable"]);
    expect((await app.inject({ method: "GET", url: "/sw.js" })).headers["cache-control"]).toBe("no-cache");
    expect((await app.inject({ method: "GET", url: "/jobs/anything/else" })).body).toContain("<title>Blackline</title>");
    expect((await app.inject({ method: "HEAD", url: "/" })).statusCode).toBe(200);
    await app.close();
  });

  it("answers a missing file with 404 and never reads outside the web folder", async () => {
    const app = buildApp(db, opts()); await app.ready();
    expect((await app.inject({ method: "GET", url: "/assets/gone.js" })).statusCode).toBe(404);
    for (const url of ["/..%2fbl-secret.txt", "/%2e%2e/bl-secret.txt", "/assets/..%2f..%2fbl-secret.txt", "/%00", "/%zz"]) {
      const r = await app.inject({ method: "GET", url });
      expect(r.body, url).not.toContain("outside");
    }
    await app.close();
  });

  it("answers /api/... as the API: sign-in still needed, unknown API paths are JSON 404s, other methods on web paths are not served", async () => {
    const app = buildApp(db, opts()); await app.ready();
    expect((await app.inject({ method: "GET", url: "/api/health" })).json()).toEqual({ ok: true });
    const me = await app.inject({ method: "GET", url: "/api/me" });
    expect([me.statusCode, me.json().error.code]).toEqual([401, "unauthorised"]);
    const nope = await app.inject({ method: "GET", url: "/api/no-such-thing" });
    expect([nope.statusCode, nope.headers["content-type"], nope.json().error.code]).toEqual([404, "application/json; charset=utf-8", "not_found"]);
    expect((await app.inject({ method: "POST", url: "/somewhere" })).statusCode).toBe(404);
    // a real session works through the prefix
    const r = await app.inject({ method: "POST", url: "/api/auth/register", payload: { orgName: "Web Co", name: "W", email: "w@webco.test", password: PASSWORD } });
    expect(r.statusCode).toBe(201);
    const ok = await app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${r.json().token}` } });
    expect(ok.json().orgName).toBe("Web Co");
    await app.close();
  });

  it("sends the hardening headers (and HSTS only over HTTPS), and none when not asked", async () => {
    const app = buildApp(db, { ...opts(), trustProxy: true }); await app.ready();
    const plain = await app.inject({ method: "GET", url: "/" });
    expect(plain.headers["x-frame-options"]).toBe("DENY");
    expect(plain.headers["x-content-type-options"]).toBe("nosniff");
    expect(plain.headers["content-security-policy"]).toContain("script-src 'self'");
    expect(plain.headers["strict-transport-security"]).toBeUndefined();
    const https = await app.inject({ method: "GET", url: "/api/health", headers: { "x-forwarded-proto": "https" } });
    expect(https.headers["strict-transport-security"]).toContain("max-age=");
    await app.close();
    const bare = buildApp(db); await bare.ready();
    expect((await bare.inject({ method: "GET", url: "/health" })).headers["x-frame-options"]).toBeUndefined();
    await bare.close();
  });

  it("with no web folder, an unknown address is a plain 404 and the API is unchanged", async () => {
    const app = buildApp(db); await app.ready();
    expect((await app.inject({ method: "GET", url: "/anything" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    await app.close();
  });
});

describe("health", () => {
  it("proves the database answers, and says 503 when it doesn't", async () => {
    const broken: Db = { ...db, query: async () => { throw new Error("connection refused"); } };
    const app = buildApp(broken); await app.ready();
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(503);
    await app.close();
  });
});

describe("unique-rule races on a real Postgres", () => {
  it("are answered 409, not a crash", async () => {
    const racing: Db = { ...db, query: async () => { throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" }); } };
    const app = buildApp(racing, { registration: "open" }); await app.ready();
    const r = await app.inject({ method: "POST", url: "/auth/login", payload: { email: "a@b.test", password: PASSWORD } });
    expect([r.statusCode, r.json().error.code]).toEqual([409, "conflict"]);
    await app.close();
  });
});

describe("the admin tool", () => {
  it("reads flags", () => {
    expect(flags(["--org", "Acme Civil", "--email", "a@b.nz", "--flag"])).toEqual({ org: "Acme Civil", email: "a@b.nz", flag: "" });
  });

  it("creates a company, lists it, and resets a password (ending that person's sessions)", async () => {
    const d = await openPglite(); await migrate(d);
    expect(await run(d, "list", {})).toBe("No companies yet.");
    expect(await run(d, "create-company", { org: "Acme Civil", name: "Sam", email: "sam@acme.test" }, { ADMIN_PASSWORD: PASSWORD })).toContain("sam@acme.test is its owner");
    expect(await run(d, "list", {})).toBe("Acme Civil\towner\tSam <sam@acme.test>");
    const app = buildApp(d); await app.ready();
    const c = new Client(app);
    const token = (await c.post("/auth/login", { email: "sam@acme.test", password: PASSWORD })).body.token;
    expect((await new Client(app, token).get("/me")).status).toBe(200);

    await expect(run(d, "reset-password", { email: "sam@acme.test", password: "short" }, {})).rejects.toThrow(/at least 10/);
    await expect(run(d, "reset-password", { email: "nobody@acme.test", password: "a brand new password" }, {})).rejects.toThrow(/No account/);
    expect(await run(d, "reset-password", { email: "SAM@acme.test", password: "a brand new password" }, {})).toContain("2 signed-in session(s) ended"); // the one made when the company was created, and the sign-in above

    expect((await new Client(app, token).get("/me")).status).toBe(401);
    expect((await c.post("/auth/login", { email: "sam@acme.test", password: PASSWORD })).status).toBe(401);
    expect((await c.post("/auth/login", { email: "sam@acme.test", password: "a brand new password" })).status).toBe(200);
    await expect(run(d, "create-company", { org: "Dupe", name: "S", email: "sam@acme.test" }, { ADMIN_PASSWORD: PASSWORD })).rejects.toThrow(/already has an account/);
    await expect(run(d, "wat", {})).rejects.toThrow(/Commands:/);
    await app.close(); await d.close();
  });
});
