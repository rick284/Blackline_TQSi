import { createHash } from "node:crypto";
import { assembleInputs, computeTenderEstimate, submission } from "@blackline/tender";
import type { Db } from "../db.js";
import { type Ctx, HttpError, requireRole } from "../errors.js";
import { audit } from "./audit.js";
import { getJob, jobRecords, listPackages } from "./jobs.js";

const hashOf = (records: { id: string; data: unknown }[]) => createHash("sha256").update(submission.canonicalRecords(records)).digest("hex");

export interface RevisionSummary {
  id: string;
  seq: number;
  label: string;
  note: string;
  issuedBy: string;
  issuedAt: string;
  totals: Record<string, string>;
  overrides: { text: string; reason: string }[];
  supersededBy: string | null;
  supersededByLabel: string | null;
  supersededAt: string | null;
  /** True when the stored records still hash to what they hashed to when it was issued */
  verified: boolean;
}

const summaryRow = (r: any, byId: Map<string, string>): RevisionSummary => ({
  id: r.id, seq: r.seq, label: r.label, note: r.note, issuedBy: r.issued_by_name, issuedAt: r.issued_at, totals: r.totals, overrides: r.overrides,
  supersededBy: r.superseded_by, supersededByLabel: r.superseded_by ? byId.get(r.superseded_by) ?? null : null, supersededAt: r.superseded_at,
  verified: hashOf(r.snapshot) === r.snapshot_hash,
});

export async function listRevisions(db: Db, ctx: Ctx, jobId: string): Promise<RevisionSummary[]> {
  await getJob(db, ctx, jobId);
  const rows = (await db.query<any>(
    `select r.*, u.name as issued_by_name from tender_revisions r join users u on u.id = r.issued_by
      where r.job_id = $1 and r.org_id = $2 order by r.seq desc`, [jobId, ctx.orgId])).rows;
  const labels = new Map<string, string>(rows.map((r) => [r.id, r.label]));
  return rows.map((r) => summaryRow(r, labels));
}

/** What a revision was, record for record: for showing it, or setting it beside another. */
export async function revisionRecords(db: Db, ctx: Ctx, revisionId: string) {
  const r = (await db.query<any>(
    `select r.*, u.name as issued_by_name from tender_revisions r join users u on u.id = r.issued_by where r.id = $1 and r.org_id = $2`, [revisionId, ctx.orgId])).rows[0];
  if (!r) throw new HttpError(404, "not_found", "Revision not found.");
  const sup = r.superseded_by ? (await db.query<{ label: string }>("select label from tender_revisions where id = $1 and org_id = $2", [r.superseded_by, ctx.orgId])).rows[0]?.label : undefined;
  return { revision: summaryRow(r, new Map(r.superseded_by && sup ? [[r.superseded_by, sup]] : [])), jobId: r.job_id as string, records: r.snapshot as { id: string; data: unknown }[] };
}

const letter = (seq: number) => submission.revisionLabel(seq);

/**
 * Issue the job as a new revision. It needs the manager role, every package checked in (a revision is what is stored, not what is in someone's
 * drafts) and no blockers; an owner can issue past blockers by giving a reason, which is kept on the revision. The previous issued revision is
 * superseded in the same transaction, and the job's status becomes 'issued'.
 */
export async function issueRevision(db: Db, ctx: Ctx, jobId: string, o: { note?: string; overrideReason?: string }): Promise<RevisionSummary> {
  requireRole(ctx, "manager");
  return db.tx(async (t) => {
    const job = await getJob(t, ctx, jobId);
    if (job.status === "awarded") throw new HttpError(409, "awarded", "This job has been awarded, so its tender can't be issued again. Changes to the work from here are variations.");
    const pkgs = await listPackages(t, ctx, jobId);
    const held = pkgs.filter((p) => p.lock);
    if (held.length) throw new HttpError(409, "packages_checked_out", `Everything has to be checked in before a tender is issued. Still checked out: ${held.map((p) => `${p.name} (${p.lock!.holder_name})`).join(", ")}.`);
    const records = (await jobRecords(t, ctx, jobId)).map((r) => ({ id: r.id, data: r.data })).sort((a, b) => (a.id < b.id ? -1 : 1));
    if (!records.length) throw new HttpError(409, "empty_job", "This job has no estimate to issue yet.");
    const inputs = assembleInputs(records);
    const estimate = computeTenderEstimate(inputs);
    const { blockers } = submission.gates(estimate);
    const overrides: { text: string; reason: string }[] = [];
    if (blockers.length) {
      const reason = (o.overrideReason ?? "").trim();
      if (!reason) throw new HttpError(409, "blocked", `This tender can't be issued yet: ${blockers.map((b) => b.text).join(" ")}`);
      if (ctx.role !== "owner") throw new HttpError(403, "forbidden", `This tender has blockers (${blockers.map((b) => b.text).join(" ")}). Only an owner can issue past them, with a reason.`);
      for (const b of blockers) overrides.push({ text: b.text, reason });
    }
    const prev = (await t.query<{ id: string; seq: number }>("select id, seq from tender_revisions where job_id = $1 and org_id = $2 order by seq desc limit 1 for update", [jobId, ctx.orgId])).rows[0];
    const seq = (prev?.seq ?? 0) + 1;
    const label = letter(seq);
    const hash = hashOf(records);
    const id = (await t.query<{ id: string }>(
      `insert into tender_revisions (org_id, job_id, seq, label, note, issued_by, snapshot, snapshot_hash, totals, overrides)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
      [ctx.orgId, jobId, seq, label, (o.note ?? "").trim().slice(0, 2000), ctx.userId, JSON.stringify(records), hash, JSON.stringify(submission.headlineTotals(estimate)), JSON.stringify(overrides)])).rows[0]!.id;
    if (prev) await t.query("update tender_revisions set superseded_by = $1, superseded_at = now() where id = $2 and org_id = $3 and superseded_by is null", [id, prev.id, ctx.orgId]);
    await t.query("update jobs set status = 'issued' where id = $1 and org_id = $2", [jobId, ctx.orgId]);
    await audit(t, ctx, "revision.issued", { jobId, detail: { label, seq, hash, overridden: overrides.length, supersedes: prev?.seq ?? null } });
    return (await listRevisions(t, ctx, jobId)).find((r) => r.id === id)!;
  });
}
