import { assembleInputs, documents, gantt, loadMasterWorkbook, procurement, splitIntoPackages, submission, template } from "@blackline/tender";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z, ZodError, type ZodType } from "zod";
import type { Db } from "./db.js";
import { type Ctx, HttpError, type Role, requireRole } from "./errors.js";
import * as accounts from "./repo/accounts.js";
import { listAudit } from "./repo/audit.js";
import * as co from "./repo/checkout.js";
import { computeJobEstimate } from "./repo/estimate.js";
import * as contacts from "./repo/contacts.js";
import * as contracts_ from "./repo/contracts.js";
import * as cost from "./repo/cost.js";
import * as exports_ from "./repo/exports.js";
import * as enquiries from "./repo/enquiries.js";
import * as jobs from "./repo/jobs.js";
import * as revisions from "./repo/revisions.js";
import { minutes, RateLimiter } from "./ratelimit.js";
import { SECURITY_HEADERS, webHandler } from "./web.js";

declare module "fastify" {
  interface FastifyRequest {
    session: accounts.Session | null;
    token: string | null;
  }
}

const parse = <T>(schema: ZodType<T>, data: unknown): T => {
  const r = schema.safeParse(data);
  if (!r.success) throw new HttpError(400, "bad_request", r.error.issues.map((i) => `${i.path.join(".") || "request"}: ${i.message}`).join("; "));
  return r.data;
};

const id = z.uuid();
/** A malformed id is "not found", the same answer as for an id that belongs to another company. */
const idParam = (v: unknown) => {
  const r = id.safeParse(v);
  if (!r.success) throw new HttpError(404, "not_found", "Not found.");
  return r.data;
};

const roleSchema = z.enum(["owner", "manager", "estimator", "viewer"]);
const record = z.object({ kind: z.string().min(1).max(40), seq: z.number().int().optional(), body: z.any() });
const changeSet = z.object({
  baseVersion: z.number().int().min(1),
  upserts: z.record(z.string().min(1).max(200), record).default({}),
  deletes: z.array(z.string().min(1).max(200)).default([]),
}).refine((c) => !c.deletes.some((d) => d in c.upserts), { message: "A record cannot be both changed and deleted in the same check-in.", path: ["deletes"] });

const PUBLIC = new Set(["/health", "/auth/status", "/auth/register", "/auth/login"]);

/**
 * How the server is run. Everything is off by default, which is what development and the tests want; `main.ts` turns it on for a hosted server.
 *  - webDir: serve the built web app from here (and answer `/api/...` as the API), so one server is the whole product.
 *  - registration: who may start a new company. "open" = anyone, "first" = only while there are no companies (the owner sets up their own), "closed" = nobody
 *    (companies are made with the admin tool).
 *  - rateLimit: slow down password guessing and sign-up spam.
 *  - trustProxy: believe `X-Forwarded-For` (set this only when the server really sits behind the host's proxy, or anyone could fake an address).
 *  - secureHeaders: send the browser-hardening headers (and HSTS on HTTPS requests).
 */
export interface AppOptions {
  webDir?: string;
  registration?: "open" | "first" | "closed";
  rateLimit?: boolean | { loginPerEmail?: number; loginPerIp?: number; registerPerIp?: number; windowMs?: number };
  trustProxy?: boolean | number;
  secureHeaders?: boolean;
}

/**
 * The visitor's address when `hops` proxies sit in front of the server. Each proxy adds the address it saw to the END of X-Forwarded-For, so the
 * visitor is `hops` entries from the right; anything a visitor writes themselves sits further left and is ignored. With no proxy it is the socket's.
 */
export function clientIp(forwardedFor: string | string[] | undefined, socketIp: string, hops: number): string {
  if (hops <= 0) return socketIp;
  const list = String(Array.isArray(forwardedFor) ? forwardedFor.join(",") : forwardedFor ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return list[Math.max(0, list.length - hops)] ?? socketIp;
}

export function buildApp(db: Db, opts: AppOptions = {}): FastifyInstance {
  const hops = opts.trustProxy === true ? 1 : opts.trustProxy || 0;
  const app = Fastify({
    logger: false,
    bodyLimit: 5 * 1024 * 1024,
    trustProxy: hops > 0, // (for the https check; the visitor's address is worked out below, counting from the proxy end)
    // the web app calls `/api/...`; behind a host there is no proxy to strip it, so the server does
    rewriteUrl: (req) => { const u = req.url ?? "/"; return u === "/api" ? "/" : u.startsWith("/api/") || u.startsWith("/api?") ? u.slice(4) : u; },
  });
  app.decorateRequest("session", null);
  app.decorateRequest("token", null);

  const ipOf = (req: FastifyRequest) => clientIp(req.headers["x-forwarded-for"], req.socket.remoteAddress ?? "", hops);
  const registration = opts.registration ?? "open";
  const rl = opts.rateLimit ? (opts.rateLimit === true ? {} : opts.rateLimit) : null;
  const windowMs = rl?.windowMs ?? 15 * 60_000;
  const limits = rl && { email: new RateLimiter(rl.loginPerEmail ?? 8, windowMs), ip: new RateLimiter(rl.loginPerIp ?? 40, windowMs), register: new RateLimiter(rl.registerPerIp ?? 5, 60 * 60_000) };
  const limited = (r: { ok: boolean; retryAfterSec: number }, reply: import("fastify").FastifyReply, what: string) => {
    if (r.ok) return;
    reply.header("retry-after", String(r.retryAfterSec));
    throw new HttpError(429, "too_many_attempts", `Too many ${what}. Try again in ${minutes(r.retryAfterSec)}.`);
  };

  if (opts.secureHeaders) {
    app.addHook("onSend", async (req, reply) => {
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) reply.header(k, v);
      if (req.protocol === "https") reply.header("strict-transport-security", "max-age=31536000");
    });
  }

  if (opts.webDir) {
    const web = webHandler(opts.webDir);
    app.setNotFoundHandler((req, reply) => {
      const isApi = (req as any).originalUrl?.startsWith("/api/") || (req as any).originalUrl === "/api";
      if (isApi || (req.method !== "GET" && req.method !== "HEAD")) return reply.status(404).send({ error: { code: "not_found", message: "Not found." } });
      return web(req, reply);
    });
  }

  // a workbook upload arrives as raw bytes
  app.addContentTypeParser(["application/octet-stream", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"], { parseAs: "buffer", bodyLimit: 50 * 1024 * 1024 }, (_req, body, done) => done(null, body));

  app.addHook("preHandler", async (req) => {
    if (req.is404 || PUBLIC.has(req.url.split("?")[0]!)) return; // an unknown address is the web app's (or a plain 404), not a protected route
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
    const session = m ? await accounts.sessionFor(db, m[1]!) : null;
    if (!session) throw new HttpError(401, "unauthorised", "Sign in to continue.");
    req.session = session;
    req.token = m![1]!;
  });

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: { code: err.code, message: err.message } });
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: "bad_request", message: err.message } });
    if (err?.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: { code: err.code ?? "bad_request", message: err.message } });
    // two people doing the same thing at once on a real Postgres: the unique rule that decides it is the answer, not a crash
    if (err?.code === "23505") return reply.status(409).send({ error: { code: "conflict", message: "That already exists, or someone else just added it. Refresh and look again." } });
    if (err?.code === "40001" || err?.code === "40P01") return reply.status(503).send({ error: { code: "busy", message: "The database was busy with someone else's change. Try again." } });
    console.error(err);
    return reply.status(500).send({ error: { code: "server_error", message: "Something went wrong on our side." } });
  });

  const ctx = (req: FastifyRequest): Ctx => ({ userId: req.session!.userId, orgId: req.session!.orgId, role: req.session!.role });

  // for a host's "is it up" check: it also proves the database answers
  app.get("/health", async (_req, reply) => {
    try { await db.query("select 1"); } catch { return reply.status(503).send({ ok: false }); }
    return { ok: true };
  });

  // ---- accounts
  const registrationOpen = async () => registration === "open" || (registration === "first" && (await db.query("select 1 from organisations limit 1")).rows.length === 0);
  app.get("/auth/status", async () => ({ registration: await registrationOpen() }));
  app.post("/auth/register", async (req, reply) => {
    if (!(await registrationOpen())) throw new HttpError(403, "registration_closed", "New companies are set up by the Blackline administrator. Ask them to add yours.");
    if (limits) limited(limits.register.hit(ipOf(req)), reply, "sign-up attempts");
    const v = parse(z.object({ orgName: z.string().trim().min(1).max(120), name: z.string().trim().min(1).max(120), email: z.email(), password: z.string().min(1).max(200) }), req.body);
    return reply.status(201).send(await accounts.registerOrganisation(db, v));
  });
  app.post("/auth/login", async (req, reply) => {
    const v = parse(z.object({ email: z.email(), password: z.string().min(1).max(200), orgId: id.optional() }), req.body);
    const emailKey = v.email.trim().toLowerCase();
    if (limits) {
      limited(limits.ip.hit(ipOf(req)), reply, "sign-in attempts");
      limited(limits.email.hit(emailKey), reply, "sign-in attempts for this email");
    }
    const r = await accounts.login(db, v);
    limits?.email.reset(emailKey); // getting in clears that person's count
    return r;
  });
  app.post("/auth/logout", async (req, reply) => {
    await accounts.logout(db, req.token!);
    return reply.status(204).send();
  });
  app.get("/me", async (req) => req.session);

  app.get("/org/members", async (req) => accounts.listMembers(db, ctx(req)));
  app.post("/org/members", async (req, reply) => {
    const v = parse(z.object({ name: z.string().trim().min(1).max(120), email: z.email(), password: z.string().min(1).max(200), role: roleSchema.default("estimator") }), req.body);
    return reply.status(201).send(await accounts.addMember(db, ctx(req), { ...v, role: v.role as Role }));
  });
  app.get("/audit", async (req) => {
    if (req.session!.role !== "owner" && req.session!.role !== "manager") throw new HttpError(403, "forbidden", "This needs the manager role or higher.");
    return listAudit(db, req.session!.orgId);
  });

  // ---- jobs
  app.get("/jobs", async (req) => jobs.listJobs(db, ctx(req)));
  const enquiryFields = {
    contactId: id.nullable().optional(), ownerId: id.nullable().optional(), dueAt: z.string().max(40).nullable().optional(),
    notes: z.string().max(2000).optional(), approxValue: z.string().max(40).optional(),
  };
  app.post("/jobs", async (req, reply) => {
    const v = parse(z.object({ name: z.string().trim().min(1).max(200), client: z.string().trim().max(200).optional(), ...enquiryFields }), req.body);
    return reply.status(201).send(await jobs.createJob(db, ctx(req), v));
  });

  // ---- contacts (company-wide) and the enquiry register (the job record itself)
  const contactFields = {
    name: z.string().max(200).optional(), kind: z.string().max(20).optional(), person: z.string().max(200).optional(), phone: z.string().max(40).optional(),
    email: z.string().max(200).optional(), trade: z.string().max(200).optional(), notes: z.string().max(2000).optional(),
  };
  app.get("/contacts", async (req) => contacts.listContacts(db, ctx(req), { archived: (req.query as any)?.archived === "1" }));
  app.post("/contacts", async (req, reply) => reply.status(201).send(await contacts.createContact(db, ctx(req), parse(z.object(contactFields), req.body))));
  app.post("/contacts/:contactId", async (req) => contacts.updateContact(db, ctx(req), idParam((req.params as any).contactId), parse(z.object(contactFields), req.body)));
  app.post("/contacts/:contactId/archive", async (req) => contacts.setArchived(db, ctx(req), idParam((req.params as any).contactId), true));
  app.post("/contacts/:contactId/restore", async (req) => contacts.setArchived(db, ctx(req), idParam((req.params as any).contactId), false));
  app.get("/contacts/:contactId/history", async (req) => contacts.contactHistory(db, ctx(req), idParam((req.params as any).contactId)));
  app.post("/jobs/:jobId/enquiry", async (req) => enquiries.updateEnquiry(db, ctx(req), idParam((req.params as any).jobId), parse(z.object(enquiryFields), req.body)));
  app.post("/jobs/:jobId/decision", async (req) => {
    const v = parse(z.object({ decision: z.enum(["go", "no-bid", "lost", "reopen"]), reason: z.string().max(1000).optional() }), req.body);
    return enquiries.decide(db, ctx(req), idParam((req.params as any).jobId), v);
  });
  app.get("/jobs/:jobId", async (req) => jobs.getJob(db, ctx(req), idParam((req.params as any).jobId)));
  app.get("/jobs/:jobId/packages", async (req) => jobs.listPackages(db, ctx(req), idParam((req.params as any).jobId)));
  app.get("/jobs/:jobId/records", async (req) => {
    const jobId = idParam((req.params as any).jobId);
    const [packages, records] = await Promise.all([jobs.listPackages(db, ctx(req), jobId), jobs.jobRecordsByPackage(db, ctx(req), jobId)]);
    return { packages, records };
  });
  app.get("/jobs/:jobId/estimate",async (req) => computeJobEstimate(db, ctx(req), idParam((req.params as any).jobId)));
  app.get("/jobs/:jobId/parked", async (req) => co.listParked(db, ctx(req), idParam((req.params as any).jobId)));

  // a tender started from nothing: the standard commercial stack and the packages every tender is built from (an estimator can; an import needs a manager)
  app.post("/jobs/:jobId/template", async (req, reply) => {
    const v = parse(z.object({ overheadPct: z.string().max(10).optional(), profitPct: z.string().max(10).optional() }), req.body ?? {});
    const jobId = idParam((req.params as any).jobId);
    const job = await jobs.getJob(db, ctx(req), jobId);
    let seeds;
    try { seeds = template.blankTender({ project: job.name, overheadPct: v.overheadPct ?? "10", profitPct: v.profitPct ?? "15" }); } catch (e) { throw e instanceof template.TemplateError ? new HttpError(400, "bad_request", e.message) : e; }
    return reply.status(201).send(await jobs.seedPackages(db, ctx(req), jobId, seeds, "estimator", "job.template"));
  });

  // a new QS section: a package of its own, so it is checked out like any other
  app.post("/jobs/:jobId/sections", async (req, reply) => {
    const v = parse(z.object({ name: z.string().max(200) }), req.body);
    const jobId = idParam((req.params as any).jobId);
    const existing = (await jobs.listPackages(db, ctx(req), jobId)).filter((p) => p.kind === "qs-section").map((p) => p.name);
    let seed;
    try { seed = template.sectionPackage(v.name, existing); } catch (e) { throw e instanceof template.TemplateError ? new HttpError(400, "bad_request", e.message) : e; }
    const r = await jobs.ensurePackage(db, ctx(req), jobId, seed);
    if (!r.created) throw new HttpError(409, "section_exists", `${seed.name} is already a section.`);
    return reply.status(201).send({ ...r, name: seed.name });
  });

  // the Gantt gets its own package, so a planner can hold it while an estimator holds the programme
  app.post("/jobs/:jobId/gantt", async (req, reply) => {
    const v = parse(z.object({ name: z.string().trim().min(1).max(200).optional(), start: z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/).optional() }), req.body ?? {});
    const jobId = idParam((req.params as any).jobId);
    const job = await jobs.getJob(db, ctx(req), jobId);
    const start = v.start ? (v.start.length === 10 ? `${v.start}T08:00:00` : v.start.length === 16 ? `${v.start}:00` : v.start) : `${new Date().toISOString().slice(0, 10)}T08:00:00`;
    const r = await jobs.ensurePackage(db, ctx(req), jobId, gantt.ganttSeedPackage(gantt.newProject(start, v.name ?? (job as any).name ?? "Project")));
    return reply.status(r.created ? 201 : 200).send(r);
  });

  // the Submission package: the tender letter and qualifications, drafted from the register
  app.post("/jobs/:jobId/submission", async (req, reply) => {
    const jobId = idParam((req.params as any).jobId);
    const job = (await jobs.getJob(db, ctx(req), jobId)) as any;
    const register = assembleInputs(await jobs.jobRecords(db, ctx(req), jobId)).register ?? [];
    const r = await jobs.ensurePackage(db, ctx(req), jobId, submission.submissionSeed({ name: job.name, client: job.client ?? "" }, register));
    return reply.status(r.created ? 201 : 200).send(r);
  });

  // the Tender Documents package: the documents the register already lists, each as its first revision
  app.post("/jobs/:jobId/documents", async (req, reply) => {
    const jobId = idParam((req.params as any).jobId);
    await jobs.getJob(db, ctx(req), jobId);
    const register = assembleInputs(await jobs.jobRecords(db, ctx(req), jobId)).register ?? [];
    const r = await jobs.ensurePackage(db, ctx(req), jobId, documents.documentsPackage(register));
    return reply.status(r.created ? 201 : 200).send(r);
  });

  // the Tender Procurement package: one package per name in the quote register, linked to the subcontract package of the same name
  app.post("/jobs/:jobId/procurement", async (req, reply) => {
    const jobId = idParam((req.params as any).jobId);
    await jobs.getJob(db, ctx(req), jobId);
    const inputs = assembleInputs(await jobs.jobRecords(db, ctx(req), jobId));
    const r = await jobs.ensurePackage(db, ctx(req), jobId, procurement.procurementPackage(inputs.quotes ?? [], inputs.overlays ?? []));
    return reply.status(r.created ? 201 : 200).send(r);
  });

  // award: the contract, its terms and the control budget copied from an issued revision
  app.get("/jobs/:jobId/contract", async (req) => ({ contract: await contracts_.getContract(db, ctx(req), idParam((req.params as any).jobId)) }));
  app.post("/jobs/:jobId/award", async (req, reply) => {
    const v = parse(z.object({ revisionId: id, contractSum: z.string().max(40).optional(), awardedOn: z.string().max(10).optional(), terms: z.record(z.string(), z.string().max(2000)).optional() }), req.body);
    return reply.status(201).send(await contracts_.awardJob(db, ctx(req), idParam((req.params as any).jobId), v));
  });
  app.post("/jobs/:jobId/contract", async (req) =>
    contracts_.updateTerms(db, ctx(req), idParam((req.params as any).jobId), parse(z.record(z.string(), z.string().max(2000)), req.body)));

  // cost control: ledgers measured against the control budget (an awarded job only)
  const J = (req: FastifyRequest) => idParam((req.params as any).jobId);
  const rec = z.record(z.string(), z.any());
  app.get("/jobs/:jobId/cost", async (req) => cost.costData(db, ctx(req), J(req)));
  app.post("/jobs/:jobId/cost/commitments", async (req, reply) => reply.status(201).send(await cost.addCommitment(db, ctx(req), J(req), parse(rec, req.body))));
  app.post("/jobs/:jobId/cost/actuals", async (req, reply) => reply.status(201).send(await cost.addActual(db, ctx(req), J(req), parse(rec, req.body))));
  app.post("/jobs/:jobId/cost/:kind/:entryId/void", async (req, reply) => {
    const { kind, entryId } = req.params as any;
    if (!["commitments", "actuals", "claims"].includes(kind)) throw new HttpError(404, "not_found", "Not found.");
    await cost.voidEntry(db, ctx(req), J(req), kind, idParam(entryId), parse(z.object({ reason: z.string().max(500) }), req.body).reason);
    return reply.status(204).send();
  });
  app.post("/jobs/:jobId/cost/variations", async (req, reply) => reply.status(201).send(await cost.addVariation(db, ctx(req), J(req), parse(rec, req.body))));
  app.post("/jobs/:jobId/cost/variations/:variationId", async (req, reply) => {
    await cost.updateVariation(db, ctx(req), J(req), idParam((req.params as any).variationId), parse(rec, req.body));
    return reply.status(204).send();
  });
  app.post("/jobs/:jobId/cost/variations/:variationId/decision", async (req, reply) => {
    await cost.decideVariation(db, ctx(req), J(req), idParam((req.params as any).variationId), parse(z.object({ decision: z.enum(["approved", "rejected"]), note: z.string().max(1000).optional() }), req.body));
    return reply.status(204).send();
  });
  app.post("/jobs/:jobId/cost/forecast", async (req, reply) => {
    await cost.setForecast(db, ctx(req), J(req), parse(rec, req.body));
    return reply.status(204).send();
  });
  app.post("/jobs/:jobId/cost/claims", async (req, reply) => reply.status(201).send(await cost.addClaim(db, ctx(req), J(req), parse(rec, req.body))));
  app.post("/jobs/:jobId/cost/claims/:claimId", async (req, reply) => {
    await cost.updateClaim(db, ctx(req), J(req), idParam((req.params as any).claimId), parse(z.object({ status: z.enum(["draft", "submitted", "paid"]), on: z.string().max(10).optional(), paidAmount: z.string().max(40).optional() }), req.body));
    return reply.status(204).send();
  });

  // files: the estimate as Excel and the tender letter as PDF, for the job as it stands or an issued revision exactly as sent
  const send = (reply: import("fastify").FastifyReply, f: exports_.FileOut) =>
    reply.header("content-type", f.type).header("content-disposition", `attachment; filename="${f.name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(f.name)}`).header("cache-control", "no-store").send(f.body);
  app.get("/jobs/:jobId/export/estimate.xlsx", async (req, reply) => send(reply, await exports_.estimateXlsx(db, ctx(req), J(req))));
  app.get("/jobs/:jobId/export/letter.pdf", async (req, reply) => send(reply, await exports_.letterPdfOf(db, ctx(req), J(req))));
  app.get("/revisions/:revisionId/export/estimate.xlsx", async (req, reply) => send(reply, await exports_.revisionXlsx(db, ctx(req), idParam((req.params as any).revisionId))));
  app.get("/revisions/:revisionId/export/letter.pdf", async (req, reply) => send(reply, await exports_.revisionLetterPdf(db, ctx(req), idParam((req.params as any).revisionId))));

  // issued revisions: frozen, never edited, only superseded
  app.get("/jobs/:jobId/revisions", async (req) => revisions.listRevisions(db, ctx(req), idParam((req.params as any).jobId)));
  app.post("/jobs/:jobId/revisions", async (req, reply) => {
    const v = parse(z.object({ note: z.string().max(2000).optional(), overrideReason: z.string().max(2000).optional() }), req.body ?? {});
    return reply.status(201).send(await revisions.issueRevision(db, ctx(req), idParam((req.params as any).jobId), v));
  });
  app.get("/revisions/:revisionId/records", async (req) => revisions.revisionRecords(db, ctx(req), idParam((req.params as any).revisionId)));

  app.post("/jobs/:jobId/import-workbook", async (req, reply) => {
    const jobId = idParam((req.params as any).jobId);
    requireRole(ctx(req), "manager");
    await jobs.getJob(db, ctx(req), jobId); // another company's job is a 404 before the file is even looked at
    if (!Buffer.isBuffer(req.body)) throw new HttpError(415, "unsupported_media_type", "Send the .xlsx file as the request body (application/octet-stream).");
    let wb;
    try {
      wb = await loadMasterWorkbook(req.body);
    } catch (e: any) {
      throw new HttpError(422, "unreadable_workbook", e?.message ?? "That file could not be read as a Master Estimate Workbook.");
    }
    return reply.status(201).send({ ...(await jobs.seedPackages(db, ctx(req), jobId, splitIntoPackages(wb))), notes: wb.notes });
  });

  app.post("/jobs/:jobId/append", async (req, reply) => {
    const v = parse(z.object({ recordId: z.string().min(1).max(200), data: z.any() }), req.body);
    const r = await co.appendJobRecord(db, ctx(req), idParam((req.params as any).jobId), v.recordId, v.data);
    return reply.status(r.created ? 201 : 200).send(r);
  });

  // ---- packages: checkout, check-in, release, break
  app.get("/packages/:packageId", async (req) => jobs.getPackage(db, ctx(req), idParam((req.params as any).packageId)));
  app.post("/packages/:packageId/checkout", async (req) => co.checkOutPackage(db, ctx(req), idParam((req.params as any).packageId)));
  app.post("/packages/:packageId/checkin", async (req, reply) => {
    const v = parse(changeSet, req.body);
    const r = await co.checkInPackage(db, ctx(req), idParam((req.params as any).packageId), v.baseVersion, { upserts: v.upserts, deletes: v.deletes });
    return reply.status(r.accepted ? 200 : 409).send(r.accepted ? r : { error: { code: r.reason.replace(/-/g, "_"), message: r.message }, parkedId: r.parkedId });
  });
  app.post("/packages/:packageId/release", async (req, reply) => {
    await co.releaseLock(db, ctx(req), idParam((req.params as any).packageId));
    return reply.status(204).send();
  });
  app.post("/packages/:packageId/break-lock", async (req) => co.breakPackageLock(db, ctx(req), idParam((req.params as any).packageId)));
  app.post("/parked/:parkedId/resolve", async (req, reply) => {
    await co.resolveParked(db, ctx(req), idParam((req.params as any).parkedId));
    return reply.status(204).send();
  });

  return app;
}
