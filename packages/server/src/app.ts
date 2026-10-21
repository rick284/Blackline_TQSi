import { assembleInputs, gantt, loadMasterWorkbook, splitIntoPackages, submission } from "@blackline/tender";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z, ZodError, type ZodType } from "zod";
import type { Db } from "./db.js";
import { type Ctx, HttpError, type Role, requireRole } from "./errors.js";
import * as accounts from "./repo/accounts.js";
import { listAudit } from "./repo/audit.js";
import * as co from "./repo/checkout.js";
import { computeJobEstimate } from "./repo/estimate.js";
import * as contacts from "./repo/contacts.js";
import * as enquiries from "./repo/enquiries.js";
import * as jobs from "./repo/jobs.js";
import * as revisions from "./repo/revisions.js";

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

const PUBLIC = new Set(["/health", "/auth/register", "/auth/login"]);

export function buildApp(db: Db): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 5 * 1024 * 1024 });
  app.decorateRequest("session", null);
  app.decorateRequest("token", null);

  // a workbook upload arrives as raw bytes
  app.addContentTypeParser(["application/octet-stream", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"], { parseAs: "buffer", bodyLimit: 50 * 1024 * 1024 }, (_req, body, done) => done(null, body));

  app.addHook("preHandler", async (req) => {
    if (PUBLIC.has(req.url.split("?")[0]!)) return;
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
    console.error(err);
    return reply.status(500).send({ error: { code: "server_error", message: "Something went wrong on our side." } });
  });

  const ctx = (req: FastifyRequest): Ctx => ({ userId: req.session!.userId, orgId: req.session!.orgId, role: req.session!.role });

  app.get("/health", async () => ({ ok: true }));

  // ---- accounts
  app.post("/auth/register", async (req, reply) => {
    const v = parse(z.object({ orgName: z.string().trim().min(1).max(120), name: z.string().trim().min(1).max(120), email: z.email(), password: z.string().min(1).max(200) }), req.body);
    return reply.status(201).send(await accounts.registerOrganisation(db, v));
  });
  app.post("/auth/login", async (req) => {
    const v = parse(z.object({ email: z.email(), password: z.string().min(1).max(200), orgId: id.optional() }), req.body);
    return accounts.login(db, v);
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
