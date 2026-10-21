import { expect } from "vitest";
import { splitIntoPackages, type TenderInputs } from "@blackline/tender";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createServer } from "node:net";
import { type Db, migrate, openPg, openPglite } from "../src/db.js";
import type { Ctx } from "../src/errors.js";
import * as jobs from "../src/repo/jobs.js";

export interface TestServer {
  app: FastifyInstance;
  db: Db;
  close(): Promise<void>;
}

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)); });
});

/**
 * The same server, but on the real `pg` adapter talking Postgres's wire protocol to a PGlite socket server (set TEST_DB=pg). It proves the hosted
 * database path: parameter handling, transactions, the types that come back, and every route's SQL, without needing a Postgres install.
 * The socket server serves one connection at a time, so the pool is one connection wide here.
 */
async function pgTestServer(): Promise<TestServer> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { PGLiteSocketServer } = await import("@electric-sql/pglite-socket");
  const lite = await PGlite.create();
  const port = await freePort();
  const sock = new PGLiteSocketServer({ db: lite, port, host: "127.0.0.1" });
  await sock.start();
  const db = await openPg(`postgres://postgres:postgres@127.0.0.1:${port}/postgres`, { max: 1 });
  await migrate(db);
  const app = buildApp(db);
  await app.ready();
  return { app, db, close: async () => { await app.close(); await db.close(); await sock.stop(); await lite.close(); } };
}

export async function testServer(): Promise<TestServer> {
  if (process.env.TEST_DB === "pg") return pgTestServer();
  const db = await openPglite();
  await migrate(db);
  const app = buildApp(db);
  await app.ready();
  return { app, db, close: async () => { await app.close(); await db.close(); } };
}

export const PASSWORD = "correct horse battery";

export class Client {
  constructor(public app: FastifyInstance, public token: string | null = null) {}
  async call(method: "GET" | "POST", url: string, body?: unknown, opts: { raw?: Buffer } = {}) {
    const headers: Record<string, string> = {};
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (opts.raw) headers["content-type"] = "application/octet-stream";
    const res = await this.app.inject({ method, url, headers, payload: (opts.raw ?? (body as any)) });
    let json: any = null;
    try { json = res.body ? JSON.parse(res.body) : null; } catch { /* not JSON */ }
    return { status: res.statusCode, body: json };
  }
  get = (url: string) => this.call("GET", url);
  post = (url: string, body?: unknown) => this.call("POST", url, body ?? {});
}

/** A new company with its owner, signed in. */
export async function newCompany(s: TestServer, orgName: string, email = `owner@${orgName.toLowerCase().replace(/\W/g, "")}.test`) {
  const anon = new Client(s.app);
  const r = await anon.post("/auth/register", { orgName, name: `${orgName} Owner`, email, password: PASSWORD });
  if (r.status !== 201) throw new Error(`register failed: ${JSON.stringify(r.body)}`);
  const owner = new Client(s.app, r.body.token);
  return { owner, orgId: r.body.orgId as string, userId: r.body.userId as string };
}

/** Add a person to the owner's company and sign them in. */
export async function addPerson(s: TestServer, owner: Client, name: string, role: "manager" | "estimator" | "viewer") {
  const email = `${name.toLowerCase()}@${Math.random().toString(36).slice(2, 8)}.test`;
  const added = await owner.post("/org/members", { name, email, password: PASSWORD, role });
  if (added.status !== 201) throw new Error(`add member failed: ${JSON.stringify(added.body)}`);
  const login = await new Client(s.app).post("/auth/login", { email, password: PASSWORD });
  return { client: new Client(s.app, login.body.token), userId: added.body.userId as string, email };
}

export const ctxOf = async (c: Client): Promise<Ctx> => {
  const me = (await c.get("/me")).body;
  return { userId: me.userId, orgId: me.orgId, role: me.role };
};

/** Small estimate: two QS sections, an overlay, a commercial stack. Direct cost 14,000 (10,000 + 4,000). */
export const tiny: TenderInputs = {
  library: [{ code: "SUB", description: "Subcontract", unit: "ea", baseRate: "1" }],
  qs: [
    { code: "EW01", section: "Earthworks", description: "Bulk earthworks", unit: "m3", quantity: "1000" },
    { code: "PV01", section: "Pavements", description: "Basecourse", unit: "m2", quantity: "500" },
  ],
  rows: [
    { qsCode: "EW01", mode: "Lump Sum / Quote", resourceType: "Subcontract", resourceCode: "SUB", manualQty: "1", jobRateOverride: "10000", verified: "Yes", uid: "EW01-001" },
    { qsCode: "PV01", mode: "Lump Sum / Quote", resourceType: "Subcontract", resourceCode: "SUB", manualQty: "1", jobRateOverride: "4000", verified: "Yes", uid: "PV01-001" },
  ],
  weatherLinks: { dailyUid: "", hoursPerDay: 8, weeklyUids: [] },
  tool: { exposedPool: 0, rainWetGroundCost: 0, criticalPathDelayWd: 0, additionalBilledWeeks: 0 },
  commercial: [
    { ref: "CA17", name: "Overhead", method: "Markup %", include: "Yes", pct: "0.10", pcSum: "0" },
    { ref: "CA18", name: "Profit", method: "Margin %", include: "Yes", pct: "0.15", pcSum: "0" },
  ],
  overlays: [{ name: "Concrete sub", amount: "5000" }],
  overlap: "0",
  reference: null,
};

/** A job loaded with the tiny estimate, as a manager would do after an import. */
export async function jobWithEstimate(s: TestServer, owner: Client, name = "Test job") {
  const created = await owner.post("/jobs", { name, client: "Client" });
  const jobId = created.body.id as string;
  await jobs.seedPackages(s.db, await ctxOf(owner), jobId, splitIntoPackages(tiny));
  const pkgs = (await owner.get(`/jobs/${jobId}/packages`)).body as { id: string; key: string }[];
  const byKey = Object.fromEntries(pkgs.map((p) => [p.key, p.id]));
  return { jobId, byKey };
}

/**
 * Assert that the database itself refuses a statement (a trigger, a constraint). On Postgres, and on PGlite, the error carries the trigger's own words,
 * so `message` is checked. The PGlite socket stand-in used for TEST_DB=pg resets the connection on a SQL error instead of reporting it, so there the
 * refusal itself is the check.
 */
export const pgStandIn = process.env.TEST_DB === "pg";

export async function refuses(p: Promise<unknown>, message: RegExp): Promise<void> {
  if (process.env.TEST_DB === "pg") { await expect(p).rejects.toBeTruthy(); return; }
  await expect(p).rejects.toThrow(message);
}
