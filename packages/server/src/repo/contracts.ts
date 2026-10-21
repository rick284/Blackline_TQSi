import { createHash } from "node:crypto";
import { D } from "@blackline/engine";
import { assembleInputs, computeTenderEstimate, contract, submission } from "@blackline/tender";
import type { Db } from "../db.js";
import { type Ctx, HttpError, requireRole } from "../errors.js";
import { audit } from "./audit.js";
import { getJob } from "./jobs.js";

const hashOf = (records: { id: string; data: unknown }[]) => createHash("sha256").update(submission.canonicalRecords(records)).digest("hex");
const bad = (m: string) => new HttpError(400, "bad_request", m);

export interface Contract {
  id: string;
  jobId: string;
  revision: { id: string; label: string; seq: number; issuedAt: string; superseded: boolean; verified: boolean };
  awardedOn: string;
  awardedBy: string;
  contractSum: string;
  tenderAllIn: string;
  terms: contract.Terms;
  lines: contract.BudgetLine[];
  /** The control budget, and what the contract sum holds above it */
  budget: { cost: string; margin: string; marginPct: string };
}

export async function getContract(db: Db, ctx: Ctx, jobId: string): Promise<Contract | null> {
  await getJob(db, ctx, jobId);
  const c = (await db.query<any>(
    `select c.*, u.name as awarded_by_name, r.label, r.seq, r.issued_at, r.superseded_by, r.snapshot, r.snapshot_hash
       from contracts c join users u on u.id = c.awarded_by join tender_revisions r on r.id = c.revision_id and r.org_id = c.org_id
      where c.job_id = $1 and c.org_id = $2`, [jobId, ctx.orgId])).rows[0];
  if (!c) return null;
  const lines = (await db.query<any>("select seq, code, description, section, kind, source, amount from contract_budget_lines where contract_id = $1 and org_id = $2 order by seq", [c.id, ctx.orgId])).rows;
  const cost = lines.reduce((t: any, l: any) => t.plus(l.amount), new D(0));
  const margin = new D(c.contract_sum).minus(cost);
  return {
    id: c.id, jobId, revision: { id: c.revision_id, label: c.label, seq: c.seq, issuedAt: c.issued_at, superseded: !!c.superseded_by, verified: hashOf(c.snapshot) === c.snapshot_hash },
    awardedOn: c.awarded_on, awardedBy: c.awarded_by_name, contractSum: c.contract_sum, tenderAllIn: c.tender_all_in,
    terms: { ...contract.BLANK_TERMS, ...c.terms }, lines,
    budget: { cost: cost.toFixed(2), margin: margin.toFixed(2), marginPct: new D(c.contract_sum).isZero() ? "0.00" : margin.div(c.contract_sum).times(100).toFixed(2) },
  };
}

const asContractError = (e: unknown): never => { throw e instanceof contract.ContractError ? bad(e.message) : e; };

/**
 * Award a job from one of its issued revisions. A manager decides it. The revision stays exactly as it was issued; the award copies what it carried
 * into the control budget, line by line, and the contract sum (the tender all-in unless the client agreed something else) is recorded beside it.
 */
export async function awardJob(db: Db, ctx: Ctx, jobId: string, v: { revisionId: string; contractSum?: string; awardedOn?: string; terms?: Partial<contract.Terms> }): Promise<Contract> {
  requireRole(ctx, "manager");
  await db.tx(async (t) => {
    const job = await getJob(t, ctx, jobId);
    if ((await t.query("select 1 from contracts where job_id = $1 and org_id = $2", [jobId, ctx.orgId])).rows.length) throw new HttpError(409, "already_awarded", "This job has already been awarded.");
    if (job.status !== "issued") throw new HttpError(409, "wrong_stage", job.status === "awarded" ? "This job has already been awarded." : "Only a job with an issued tender can be awarded. Issue the tender first.");
    const rev = (await t.query<any>("select id, label, snapshot, snapshot_hash from tender_revisions where id = $1 and job_id = $2 and org_id = $3", [v.revisionId, jobId, ctx.orgId])).rows[0];
    if (!rev) throw new HttpError(404, "not_found", "That revision isn't one of this job's issued revisions.");
    if (hashOf(rev.snapshot) !== rev.snapshot_hash) throw new HttpError(409, "revision_altered", `${rev.label} no longer matches what was issued, so it can't be awarded from. Tell the owner.`);

    const inputs = assembleInputs(rev.snapshot);
    const budget = contract.budgetFrom(computeTenderEstimate(inputs), inputs);
    let sum: string, terms: contract.Terms, on: string;
    try {
      sum = v.contractSum ? contract.parseSum(v.contractSum) : budget.allIn;
      terms = contract.cleanTerms(v.terms ?? {});
    } catch (e) { return asContractError(e); }
    if (new D(sum).lte(0)) throw bad("The contract sum needs to be above zero. The tender has no price to award from.");
    on = (v.awardedOn ?? new Date().toISOString().slice(0, 10)).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(on) || new Date(`${on}T00:00:00Z`).toISOString().slice(0, 10) !== on) throw bad("The award date needs to be a real date, for example 2026-11-12.");

    const id = (await t.query<{ id: string }>(
      `insert into contracts (org_id, job_id, revision_id, awarded_on, contract_sum, tender_all_in, terms, awarded_by) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [ctx.orgId, jobId, rev.id, on, sum, budget.allIn, JSON.stringify(terms), ctx.userId])).rows[0]!.id;
    for (const l of budget.lines) {
      await t.query("insert into contract_budget_lines (contract_id, org_id, seq, code, description, section, kind, source, amount) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
        [id, ctx.orgId, l.seq, l.code, l.description, l.section, l.kind, l.source, l.amount]);
    }
    await t.query("update jobs set status = 'awarded', decided_at = now(), decided_by = $3, decision_reason = '' where id = $1 and org_id = $2", [jobId, ctx.orgId, ctx.userId]);
    await audit(t, ctx, "contract.awarded", { jobId, detail: { revision: rev.label, contractSum: sum, tenderAllIn: budget.allIn, budgetCost: budget.cost, lines: budget.lines.length } });
  });
  return (await getContract(db, ctx, jobId))!;
}

/** The contract form and terms, edited by a manager. Each change is checked and recorded in the audit trail. */
export async function updateTerms(db: Db, ctx: Ctx, jobId: string, change: Partial<contract.Terms>): Promise<Contract> {
  requireRole(ctx, "manager");
  await db.tx(async (t) => {
    await getJob(t, ctx, jobId);
    const c = (await t.query<any>("select id, terms from contracts where job_id = $1 and org_id = $2 for update", [jobId, ctx.orgId])).rows[0];
    if (!c) throw new HttpError(404, "not_found", "This job hasn't been awarded yet.");
    let next: contract.Terms;
    try { next = contract.cleanTerms(change, { ...contract.BLANK_TERMS, ...c.terms }); } catch (e) { return asContractError(e); }
    const was = { ...contract.BLANK_TERMS, ...c.terms };
    const changed = (Object.keys(next) as (keyof contract.Terms)[]).filter((k) => next[k] !== was[k]);
    if (!changed.length) return;
    await t.query("update contracts set terms = $3, updated_at = now() where id = $1 and org_id = $2", [c.id, ctx.orgId, JSON.stringify(next)]);
    await audit(t, ctx, "contract.terms", { jobId, detail: Object.fromEntries(changed.map((k) => [k, { from: was[k], to: next[k] }])) });
  });
  return (await getContract(db, ctx, jobId))!;
}
