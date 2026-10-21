import { costControl as K } from "@blackline/tender";
import type { Db } from "../db.js";
import { type Ctx, HttpError, requireRole } from "../errors.js";
import { audit } from "./audit.js";
import { type Contract, getContract } from "./contracts.js";
import { getJob } from "./jobs.js";

const bad = (m: string) => new HttpError(400, "bad_request", m);
const wrap = <T>(fn: () => T): T => { try { return fn(); } catch (e) { throw e instanceof K.CostError ? bad(e.message) : e; } };

export interface CostData {
  contract: Contract;
  commitments: (K.Commitment & { voidReason: string | null; createdBy: string; createdAt: string })[];
  actuals: (K.Actual & { voidReason: string | null; createdBy: string; createdAt: string })[];
  variations: (K.Variation & { createdBy: string; decidedBy: string | null; decisionNote: string })[];
  forecasts: { code: string; etc: string | null; note: string; by: string; at: string }[];
  claims: (K.Claim & { submittedOn: string | null; paidOn: string | null; note: string; voidReason: string | null })[];
}

/** Cost control only exists for an awarded job: the control budget is what everything here is measured against. */
async function awarded(db: Db, ctx: Ctx, jobId: string): Promise<Contract> {
  await getJob(db, ctx, jobId);
  const c = await getContract(db, ctx, jobId);
  if (!c) throw new HttpError(409, "not_awarded", "Cost control starts when the job is awarded. Award it in Contract Setup first.");
  return c;
}

export async function costData(db: Db, ctx: Ctx, jobId: string): Promise<CostData> {
  const contract = await awarded(db, ctx, jobId);
  const q = <T = any>(sql: string) => db.query<T>(sql, [jobId, ctx.orgId]).then((r) => r.rows);
  const commitments = (await q(`select c.*, u.name as by from cost_commitments c join users u on u.id = c.created_by where c.job_id = $1 and c.org_id = $2 order by c.created_at, c.id`)).map((r) => ({
    id: r.id, code: r.code, supplier: r.supplier, ref: r.ref, description: r.description, amount: r.amount, date: r.date, voided: !!r.voided_at, voidReason: r.void_reason, createdBy: r.by, createdAt: r.created_at }));
  const actuals = (await q(`select a.*, u.name as by from cost_actuals a join users u on u.id = a.created_by where a.job_id = $1 and a.org_id = $2 order by a.date, a.created_at, a.id`)).map((r) => ({
    id: r.id, code: r.code, kind: r.kind, supplier: r.supplier, ref: r.ref, description: r.description, amount: r.amount, hours: r.hours, date: r.date, commitmentId: r.commitment_id,
    voided: !!r.voided_at, voidReason: r.void_reason, createdBy: r.by, createdAt: r.created_at }));
  const variations = (await q(`select v.*, u.name as by, d.name as decided_name from cost_variations v join users u on u.id = v.created_by left join users d on d.id = v.decided_by where v.job_id = $1 and v.org_id = $2 order by v.created_at, v.id`)).map((r) => ({
    id: r.id, ref: r.ref, title: r.title, status: r.status, sell: r.sell, lines: r.lines, note: r.note, createdBy: r.by, decidedBy: r.decided_name, decisionNote: r.decision_note,
    submittedOn: r.submitted_on, responseDue: r.response_due, atRisk: r.at_risk }));
  const forecasts = (await q(`select distinct on (f.code) f.code, f.etc, f.note, u.name as by, f.created_at as at from cost_forecasts f join users u on u.id = f.created_by where f.job_id = $1 and f.org_id = $2 order by f.code, f.id desc`))
    .map((r) => ({ code: r.code, etc: r.etc, note: r.note, by: r.by, at: r.at }));
  const claims = (await q(`select * from payment_claims where job_id = $1 and org_id = $2 order by seq`)).map((r) => ({
    id: r.id, seq: r.seq, periodEnd: r.period_end, valueEx: r.value_ex, retentionPct: r.retention_pct, status: r.status, paidAmount: r.paid_amount, voided: !!r.voided_at,
    submittedOn: r.submitted_on, paidOn: r.paid_on, note: r.note, voidReason: r.void_reason }));
  return { contract, commitments, actuals, variations, forecasts, claims } as CostData;
}

/** The ledger as the shared engine takes it, so the server can answer with the same totals the screens show. */
export const ledgerOf = (d: CostData): K.Ledger => ({
  contractSum: d.contract.contractSum, payDays: d.contract.terms.payDays, budget: d.contract.lines.map((l) => ({ code: l.code, description: l.description, section: l.section, amount: l.amount, kind: l.kind })),
  commitments: d.commitments, actuals: d.actuals, variations: d.variations, forecasts: d.forecasts, claims: d.claims,
});

const codesFor = async (db: Db, ctx: Ctx, jobId: string) => {
  const d = await costData(db, ctx, jobId);
  return { codes: new Set(K.codesOf(ledgerOf(d).budget, d.variations).map((c) => c.code)), data: d };
};

export async function addCommitment(db: Db, ctx: Ctx, jobId: string, v: Record<string, unknown>) {
  requireRole(ctx, "estimator");
  return db.tx(async (t) => {
    const { codes } = await codesFor(t, ctx, jobId);
    const c = wrap(() => K.cleanCommitment(v, codes));
    const id = (await t.query<{ id: string }>("insert into cost_commitments (org_id, job_id, code, supplier, ref, description, amount, date, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id",
      [ctx.orgId, jobId, c.code, c.supplier, c.ref, c.description, c.amount, c.date, ctx.userId])).rows[0]!.id;
    await audit(t, ctx, "cost.commitment", { jobId, detail: { id, code: c.code, supplier: c.supplier, amount: c.amount } });
    return { id };
  });
}

export async function addActual(db: Db, ctx: Ctx, jobId: string, v: Record<string, unknown>) {
  requireRole(ctx, "estimator");
  return db.tx(async (t) => {
    const { codes } = await codesFor(t, ctx, jobId);
    const c = wrap(() => K.cleanActual(v, codes));
    const commitmentId = v.commitmentId ? String(v.commitmentId) : null;
    if (commitmentId) {
      const po = (await t.query<{ voided_at: string | null }>("select voided_at from cost_commitments where id = $1 and job_id = $2 and org_id = $3", [commitmentId, jobId, ctx.orgId])).rows[0];
      if (!po) throw bad("That order isn't one of this job's commitments.");
      if (po.voided_at) throw bad("That order has been voided.");
    }
    const id = (await t.query<{ id: string }>(
      "insert into cost_actuals (org_id, job_id, code, kind, supplier, ref, description, amount, hours, date, commitment_id, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id",
      [ctx.orgId, jobId, c.code, c.kind, c.supplier, c.ref, c.description, c.amount, c.hours, c.date, commitmentId, ctx.userId])).rows[0]!.id;
    await audit(t, ctx, "cost.actual", { jobId, detail: { id, code: c.code, kind: c.kind, amount: c.amount } });
    return { id };
  });
}

const TABLES = { commitments: "cost_commitments", actuals: "cost_actuals", claims: "payment_claims" } as const;

/** Void a commitment, an actual cost or a claim: it stays in the ledger with who voided it and why, and counts for nothing. A manager does it. */
export async function voidEntry(db: Db, ctx: Ctx, jobId: string, kind: keyof typeof TABLES, id: string, reason: string) {
  requireRole(ctx, "manager");
  const why = reason.trim();
  if (why.length < 3) throw bad("Say why it is being voided: the reason is kept.");
  if (why.length > 500) throw bad("That reason is too long (limit 500 characters).");
  await db.tx(async (t) => {
    await awarded(t, ctx, jobId);
    const row = (await t.query<{ voided_at: string | null }>(`select voided_at from ${TABLES[kind]} where id = $1 and job_id = $2 and org_id = $3 for update`, [id, jobId, ctx.orgId])).rows[0];
    if (!row) throw new HttpError(404, "not_found", "Entry not found.");
    if (row.voided_at) throw new HttpError(409, "already_voided", "That entry has already been voided.");
    await t.query(`update ${TABLES[kind]} set voided_at = now(), voided_by = $4, void_reason = $5 where id = $1 and job_id = $2 and org_id = $3`, [id, jobId, ctx.orgId, ctx.userId, why]);
    await audit(t, ctx, `cost.void.${kind}`, { jobId, detail: { id, reason: why } });
  });
}

export async function addVariation(db: Db, ctx: Ctx, jobId: string, v: Record<string, unknown>) {
  requireRole(ctx, "estimator");
  return db.tx(async (t) => {
    const { codes } = await codesFor(t, ctx, jobId);
    const c = wrap(() => K.cleanVariation(v, codes));
    let ref = c.ref;
    if (!ref) {
      const nums = (await t.query<{ ref: string }>("select ref from cost_variations where job_id = $1 and org_id = $2", [jobId, ctx.orgId])).rows.map((r) => /(\d+)\s*$/.exec(r.ref)).filter((m): m is RegExpExecArray => !!m).map((m) => Number(m[1]));
      ref = `V${String(1 + Math.max(0, ...nums)).padStart(2, "0")}`;
    }
    if ((await t.query("select 1 from cost_variations where job_id = $1 and org_id = $2 and ref = $3", [jobId, ctx.orgId, ref])).rows.length) throw new HttpError(409, "variation_exists", `${ref} is already a variation on this job.`);
    const id = (await t.query<{ id: string }>("insert into cost_variations (org_id, job_id, ref, title, sell, lines, note, created_by, submitted_on, response_due, at_risk) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id",
      [ctx.orgId, jobId, ref, c.title, c.sell, JSON.stringify(c.lines), c.note, ctx.userId, c.submittedOn, c.responseDue, c.atRisk])).rows[0]!.id;
    await audit(t, ctx, "cost.variation", { jobId, detail: { id, ref, sell: c.sell } });
    return { id, ref };
  });
}

/** A pending variation can be reworded and repriced; once decided it is frozen (the database also refuses). */
export async function updateVariation(db: Db, ctx: Ctx, jobId: string, id: string, v: Record<string, unknown>) {
  requireRole(ctx, "estimator");
  await db.tx(async (t) => {
    const { codes } = await codesFor(t, ctx, jobId);
    const was = (await t.query<any>("select ref, status from cost_variations where id = $1 and job_id = $2 and org_id = $3 for update", [id, jobId, ctx.orgId])).rows[0];
    if (!was) throw new HttpError(404, "not_found", "Variation not found.");
    if (was.status !== "pending") throw new HttpError(409, "variation_decided", "That variation has been decided, so it can't be changed.");
    const c = wrap(() => K.cleanVariation({ ...v, ref: was.ref }, codes));
    await t.query("update cost_variations set title = $4, sell = $5, lines = $6, note = $7, submitted_on = $8, response_due = $9, at_risk = $10 where id = $1 and job_id = $2 and org_id = $3",
      [id, jobId, ctx.orgId, c.title, c.sell, JSON.stringify(c.lines), c.note, c.submittedOn, c.responseDue, c.atRisk]);
    await audit(t, ctx, "cost.variation.updated", { jobId, detail: { id, ref: was.ref } });
  });
}

/** Approving moves the budget and the contract sum; rejecting leaves them alone. A manager decides, and the decision is final. */
export async function decideVariation(db: Db, ctx: Ctx, jobId: string, id: string, v: { decision: "approved" | "rejected"; note?: string }) {
  requireRole(ctx, "manager");
  await db.tx(async (t) => {
    await awarded(t, ctx, jobId);
    const was = (await t.query<any>("select ref, status from cost_variations where id = $1 and job_id = $2 and org_id = $3 for update", [id, jobId, ctx.orgId])).rows[0];
    if (!was) throw new HttpError(404, "not_found", "Variation not found.");
    if (was.status !== "pending") throw new HttpError(409, "variation_decided", `${was.ref} has already been ${was.status}.`);
    const note = (v.note ?? "").trim().slice(0, 1000);
    if (v.decision === "rejected" && note.length < 3) throw bad("Say why it was rejected: the reason is kept.");
    await t.query("update cost_variations set status = $4, decided_by = $5, decided_at = now(), decision_note = $6 where id = $1 and job_id = $2 and org_id = $3", [id, jobId, ctx.orgId, v.decision, ctx.userId, note]);
    await audit(t, ctx, `cost.variation.${v.decision}`, { jobId, detail: { id, ref: was.ref, note } });
  });
}

export async function setForecast(db: Db, ctx: Ctx, jobId: string, v: Record<string, unknown>) {
  requireRole(ctx, "estimator");
  await db.tx(async (t) => {
    const { codes } = await codesFor(t, ctx, jobId);
    const c = wrap(() => K.cleanForecast(v, codes));
    await t.query("insert into cost_forecasts (org_id, job_id, code, etc, note, created_by) values ($1, $2, $3, $4, $5, $6)", [ctx.orgId, jobId, c.code, c.etc, c.note, ctx.userId]);
    await audit(t, ctx, "cost.forecast", { jobId, detail: { code: c.code, etc: c.etc } });
  });
}

/** A payment claim to the client. The retention percentage is the one in the contract terms when the claim is made, and stays with the claim. */
export async function addClaim(db: Db, ctx: Ctx, jobId: string, v: Record<string, unknown>) {
  requireRole(ctx, "manager");
  return db.tx(async (t) => {
    const contract = await awarded(t, ctx, jobId);
    const c = wrap(() => K.cleanClaim(v));
    const seq = 1 + ((await t.query<{ m: number | null }>("select max(seq) as m from payment_claims where job_id = $1 and org_id = $2", [jobId, ctx.orgId])).rows[0]!.m ?? 0);
    const id = (await t.query<{ id: string }>("insert into payment_claims (org_id, job_id, seq, period_end, value_ex, retention_pct, note, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id",
      [ctx.orgId, jobId, seq, c.periodEnd, c.valueEx, contract.terms.retentionPct || "0", c.note, ctx.userId])).rows[0]!.id;
    await audit(t, ctx, "cost.claim", { jobId, detail: { id, seq, value: c.valueEx } });
    return { id, seq };
  });
}

/** Move a claim along: draft -> submitted (with the date it went) -> paid (with the date and the amount received, GST included). */
export async function updateClaim(db: Db, ctx: Ctx, jobId: string, id: string, v: { status: K.ClaimStatus; on?: string; paidAmount?: string }) {
  requireRole(ctx, "manager");
  await db.tx(async (t) => {
    await awarded(t, ctx, jobId);
    const was = (await t.query<any>("select seq, status, voided_at from payment_claims where id = $1 and job_id = $2 and org_id = $3 for update", [id, jobId, ctx.orgId])).rows[0];
    if (!was) throw new HttpError(404, "not_found", "Claim not found.");
    if (was.voided_at) throw new HttpError(409, "already_voided", "That claim has been voided.");
    const order = ["draft", "submitted", "paid"];
    if (!order.includes(v.status)) throw bad("A claim is draft, submitted or paid.");
    if (order.indexOf(v.status) < order.indexOf(was.status)) throw new HttpError(409, "wrong_stage", `Claim ${was.seq} is ${was.status}; it can't go back to ${v.status}.`);
    if (v.status === "draft") return;
    const on = wrap(() => K.parseDate(v.on, v.status === "paid" ? "The date paid" : "The date submitted"));
    if (v.status === "submitted") await t.query("update payment_claims set status = 'submitted', submitted_on = $4 where id = $1 and job_id = $2 and org_id = $3", [id, jobId, ctx.orgId, on]);
    else {
      const amt = wrap(() => K.parseMoney(v.paidAmount, { what: "The amount received" }));
      await t.query("update payment_claims set status = 'paid', paid_on = $4, paid_amount = $5 where id = $1 and job_id = $2 and org_id = $3", [id, jobId, ctx.orgId, on, amt]);
    }
    await audit(t, ctx, `cost.claim.${v.status}`, { jobId, detail: { id, seq: was.seq, on, paidAmount: v.paidAmount } });
  });
}
